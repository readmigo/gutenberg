import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { v4 as uuid } from 'uuid';
import { workerClient } from './worker-client';
import { uploadEpub, uploadCover, uploadChapter } from './r2-client';
import { fetchBookById, getEpubUrl, GutendexBook } from './gutendex-client';
import { parseEpub, extractMetadata, extractChapters, extractCover, ParsedChapter } from './epub-parser';
import { cleanChapterHtml } from './content-cleaner';
import { detectChapters } from './zh-chapter-detector';
import { checkZhBookQuality } from './quality-checker-zh';
import { initJieba, analyzeZhDifficulty } from './zh-difficulty';

// Pipeline version for the Chinese processing pipeline.
// Versioned independently from the English pipeline (process-book.ts).
//
// History:
//   1 — initial Chinese pipeline: jieba-based difficulty, HSK levels, zh-chapter-detector fallback
export const PIPELINE_VERSION = 1;

// Strip HTML tags for text extraction
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Count CJK characters (Chinese/Japanese/Korean unified ideographs)
function countChineseChars(text: string): number {
  const matches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  return matches ? matches.length : 0;
}

export interface ProcessResult {
  bookId: string;
  gutenbergId: number;
  title: string;
  chapterCount: number;
  wordCount: number;
  qualityScore: number;
  qualityPass: boolean;
  qualityTier: string;
  fleschScore: number;
  cefrLevel: string;
  difficultyScore: number;
  estimatedReadingMinutes: number;
}

async function updateJobSafe(jobId: string | undefined, data: Record<string, unknown>) {
  if (!jobId) return;
  try {
    await workerClient.updateJob(jobId, data);
  } catch (err) {
    console.error(`  [warn] Failed to update job ${jobId}:`, err instanceof Error ? err.message : err);
  }
}

export async function processChineseBook(gutenbergId: number, jobId?: string, jobAttempts?: number): Promise<ProcessResult> {
  let tempFile = '';

  try {
    // Step 1: Fetch book info from Gutendex
    console.log(`  [1/9] Fetching Gutendex metadata for ID ${gutenbergId}...`);
    await updateJobSafe(jobId, { status: 'downloading' });

    const gutBook: GutendexBook | null = await fetchBookById(gutenbergId);
    if (!gutBook) {
      throw new Error(`Book not found on Gutendex: ${gutenbergId}`);
    }

    const epubUrl = getEpubUrl(gutBook);
    if (!epubUrl) {
      throw new Error(`No EPUB format available for: ${gutBook.title}`);
    }

    console.log(`  Title: ${gutBook.title}`);
    console.log(`  Author: ${gutBook.authors.map(a => a.name).join(', ') || 'Unknown'}`);
    console.log(`  EPUB: ${epubUrl}`);

    // Step 2: Download EPUB with mirror fallback.
    // Primary: aleph.pglaf.org (no rate limit, no overload)
    // Fallback: www.gutenberg.org (the Gutendex-reported URL)
    console.log(`  [2/9] Downloading EPUB...`);
    let epubBuffer!: Buffer;
    const pglafUrl = `https://aleph.pglaf.org/cache/epub/${gutenbergId}/pg${gutenbergId}-images.epub`;
    const downloadUrls: string[] = [pglafUrl, epubUrl];
    let dlOk = false;
    for (const url of downloadUrls) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const resp = await axios.get<Buffer>(url, {
            responseType: 'arraybuffer',
            timeout: 180_000,
            maxRedirects: 5,
          });
          epubBuffer = resp.data;
          dlOk = true;
          break;
        } catch (dlErr: any) {
          const msg = dlErr?.message || dlErr?.code || JSON.stringify(dlErr);
          console.error(`  Download attempt ${attempt}/3 from ${url} failed: ${msg}`);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 3000 * attempt));
          }
        }
      }
      if (dlOk) break;
    }
    if (!dlOk) {
      throw new Error(`EPUB download failed after 3 attempts on both pglaf and gutenberg.org`);
    }

    tempFile = path.join(os.tmpdir(), `pg-zh-${gutenbergId}-${Date.now()}.epub`);
    fs.writeFileSync(tempFile, epubBuffer);
    console.log(`  Downloaded ${(epubBuffer.length / 1024).toFixed(1)} KB -> ${tempFile}`);

    // Step 3: Parse EPUB
    console.log(`  [3/9] Parsing EPUB...`);
    await updateJobSafe(jobId, { status: 'parsing' });

    const epub = await parseEpub(tempFile);
    const metadata = extractMetadata(epub);
    const rawChapters = await extractChapters(epub);
    const coverData = await extractCover(epub);

    console.log(`  Metadata: ${metadata.title} by ${metadata.author}`);
    console.log(`  Raw chapters: ${rawChapters.length}, Cover: ${coverData ? 'yes' : 'no'}`);

    // Step 4: Clean chapters (Chinese pipeline: only cleanChapterHtml, no typographize/modernizeSpelling/semanticize/tagForeignPhrases)
    console.log(`  [4/9] Cleaning chapter content...`);
    await updateJobSafe(jobId, { status: 'cleaning' });

    const cleanedChapters: Array<ParsedChapter & { cleanedHtml: string; cleanedCharCount: number }> = [];
    for (const ch of rawChapters) {
      const cleaned = cleanChapterHtml(ch.htmlContent);
      const plainText = stripHtml(cleaned);
      const cleanedCharCount = countChineseChars(plainText);
      cleanedChapters.push({ ...ch, cleanedHtml: cleaned, cleanedCharCount });
    }

    // Step 5: Chinese chapter splitting fallback
    // If the EPUB TOC produced ≤ 2 chapters, attempt to detect chapters from body text
    console.log(`  [5/9] Checking chapter structure...`);
    let finalChapters = cleanedChapters;

    if (cleanedChapters.length <= 2) {
      console.log(`  Only ${cleanedChapters.length} chapter(s) detected from EPUB TOC — attempting zh-chapter-detector fallback...`);
      try {
        // Combine all cleaned HTML into a single body for detection
        const combinedHtml = cleanedChapters.map(ch => ch.cleanedHtml).join('\n');
        const detectedChapters = detectChapters(combinedHtml);
        if (detectedChapters.length > cleanedChapters.length) {
          console.log(`  zh-chapter-detector found ${detectedChapters.length} chapters (was ${cleanedChapters.length})`);
          finalChapters = detectedChapters.map((det, i) => {
            const start = det.index;
            const end = i + 1 < detectedChapters.length ? detectedChapters[i + 1].index : combinedHtml.length;
            const chunkHtml = combinedHtml.slice(start, end);
            const plainText = stripHtml(chunkHtml);
            const cleanedCharCount = countChineseChars(plainText);
            return {
              order: i + 1,
              title: det.title,
              href: '',
              htmlContent: chunkHtml,
              wordCount: 0,
              cleanedHtml: chunkHtml,
              cleanedCharCount,
            } as any;
          });
        } else {
          console.log(`  zh-chapter-detector did not improve chapter count, keeping original`);
        }
      } catch (detErr) {
        console.error(`  [warn] zh-chapter-detector failed, keeping original chapters:`, detErr instanceof Error ? detErr.message : detErr);
      }
    }

    // Filter out near-empty chapters (< 20 CJK chars)
    const usableChapters = finalChapters.filter(ch => ch.cleanedCharCount >= 20);
    if (usableChapters.length < finalChapters.length) {
      console.log(`  Filtered ${finalChapters.length - usableChapters.length} near-empty chapter(s) (< 20 CJK chars)`);
    }

    // Step 6: Quality check
    console.log(`  [6/9] Running quality check...`);
    const totalCharCount = usableChapters.reduce((sum, ch) => sum + ch.cleanedCharCount, 0);

    const quality = checkZhBookQuality(
      {
        title: metadata.title,
        chapterCount: usableChapters.length,
        wordCount: totalCharCount,
        hasCover: !!coverData,
      },
      usableChapters.map(ch => ({
        title: ch.title,
        wordCount: ch.cleanedCharCount,
        htmlContent: ch.cleanedHtml,
      })),
    );

    console.log(`  Quality: score=${quality.score}, pass=${quality.pass}, tier=${quality.tier}`);
    if (quality.issues.length > 0) {
      console.log(`  Issues: ${quality.issues.join('; ')}`);
    }

    // Step 7: Difficulty analysis (Chinese: HSK levels via jieba)
    console.log(`  [7/9] Analyzing difficulty...`);
    await initJieba();
    const sampleText = stripHtml(usableChapters.slice(0, 3).map(ch => ch.cleanedHtml).join(' ')).slice(0, 5000);
    const difficulty = analyzeZhDifficulty(sampleText);
    // Map to ProcessResult fields:
    //   fleschScore = 0 (not applicable for Chinese)
    //   cefrLevel   = HSK${level} (e.g. "HSK3")
    //   estimatedReadingMinutes = totalChars / 500
    const estimatedReadingMinutes = Math.round(totalCharCount / 500);
    console.log(`  HSK: ${difficulty.hskLevel}, Difficulty: ${difficulty.difficultyScore}, Reading: ${estimatedReadingMinutes}min`);

    // Step 8: Upload to R2
    console.log(`  [8/9] Uploading to R2...`);
    await updateJobSafe(jobId, { status: 'uploading' });

    const uploadedEpubUrl = await uploadEpub(gutenbergId, Buffer.from(epubBuffer));
    console.log(`  Uploaded EPUB: ${uploadedEpubUrl}`);

    let coverUrl: string | null = null;
    let coverSource: string | null = null;
    if (coverData) {
      coverUrl = await uploadCover(gutenbergId, coverData.data, coverData.mimeType);
      coverSource = 'epub';
      console.log(`  Uploaded cover (epub): ${coverUrl}`);
    } else {
      // Fallback: try Open Library Covers API
      console.log(`  No EPUB cover, trying Open Library...`);
      try {
        const olCoverUrl = `https://covers.openlibrary.org/b/olid/OL${gutenbergId}M-L.jpg`;
        const olResp = await axios.get(olCoverUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
          maxRedirects: 3,
          validateStatus: (s) => s === 200,
        });
        // Only use if response is actually an image (>1KB, not the 1-pixel placeholder)
        if (olResp.data.byteLength > 1000) {
          coverUrl = await uploadCover(gutenbergId, Buffer.from(olResp.data), 'image/jpeg');
          coverSource = 'openlibrary';
          console.log(`  Uploaded cover (openlibrary): ${coverUrl}`);
        } else {
          console.log(`  Open Library returned placeholder, skipping`);
        }
      } catch {
        console.log(`  Open Library cover not available`);
      }
    }

    // Upload chapters with generated UUIDs
    const chapterEntries: Array<{ id: string; orderNum: number; title: string; contentUrl: string; wordCount: number; qualityOk: number }> = [];
    for (const ch of usableChapters) {
      const chapterId = uuid();
      const contentUrl = await uploadChapter(gutenbergId, chapterId, ch.cleanedHtml);
      chapterEntries.push({
        id: chapterId,
        orderNum: ch.order,
        title: ch.title,
        contentUrl,
        wordCount: ch.cleanedCharCount,  // stored as wordCount in schema; for Chinese this is CJK char count
        qualityOk: ch.cleanedCharCount >= 20 ? 1 : 0,
      });
    }
    console.log(`  Uploaded ${chapterEntries.length} chapters`);

    // Step 9: Write to D1 via Worker API
    console.log(`  [9/9] Creating book record...`);
    const author = gutBook.authors.map(a => a.name).join(', ') || metadata.author;
    const sourceUrl = `https://www.gutenberg.org/ebooks/${gutenbergId}`;

    // Determine status based on quality tier
    let bookStatus: string;
    if (quality.tier === 'auto_approved') {
      bookStatus = 'ready'; // ≥80: auto approved, ready for sync
    } else if (quality.tier === 'needs_review') {
      bookStatus = 'pending'; // 60-79: needs AI/manual review
    } else {
      bookStatus = 'rejected'; // <60: rejected
    }

    const bookRecord = await workerClient.createBook({
      id: uuid(),
      gutenbergId: gutenbergId,
      title: metadata.title,
      author,
      language: 'zh',
      subjects: JSON.stringify(gutBook.subjects),
      description: metadata.description || null,
      coverUrl: coverUrl,
      epubUrl: uploadedEpubUrl,
      sourceUrl: sourceUrl,
      sourceType: 'gutenberg_zh',
      status: bookStatus,
      qualityScore: quality.score,
      qualityIssues: JSON.stringify(quality.issues),
      chapterCount: chapterEntries.length,
      wordCount: totalCharCount,
      fleschScore: 0,
      cefrLevel: `HSK${difficulty.hskLevel}`,
      difficultyScore: difficulty.difficultyScore,
      estimatedReadingMinutes,
      coverSource: coverSource,
      pipelineVersion: PIPELINE_VERSION,
    });

    // Use the actual DB id (may differ from uuid() if book already existed)
    const bookId = bookRecord.id;
    console.log(`  Book record saved: id=${bookId}, inserting ${chapterEntries.length} chapters...`);

    // Skip the chapter insert when the parser produced zero usable chapters.
    if (chapterEntries.length > 0) {
      await workerClient.createChapters(
        bookId,
        chapterEntries.map(ch => ({
          id: ch.id,
          orderNum: ch.orderNum,
          title: ch.title,
          contentUrl: ch.contentUrl,
          wordCount: ch.wordCount,
          qualityOk: ch.qualityOk,
        })),
      );
    } else {
      console.log(`  [warn] 0 chapters extracted - skipping chapter insert, book marked ${bookStatus}`);
    }

    // Done
    console.log(`  [9/9] Done!`);
    await updateJobSafe(jobId, { status: 'done' });

    return {
      bookId,
      gutenbergId,
      title: metadata.title,
      chapterCount: chapterEntries.length,
      wordCount: totalCharCount,
      qualityScore: quality.score,
      qualityPass: quality.pass,
      qualityTier: quality.tier,
      fleschScore: 0,
      cefrLevel: `HSK${difficulty.hskLevel}`,
      difficultyScore: difficulty.difficultyScore,
      estimatedReadingMinutes,
    };
  } catch (err: any) {
    // Update job to failed
    const errorMessage = err?.response?.data
      ? `${err.message}: ${JSON.stringify(err.response.data)}`
      : err instanceof Error ? err.message : String(err);
    console.error(`  Error detail: ${errorMessage}`);
    await updateJobSafe(jobId, {
      status: 'failed',
      errorMessage,
      attempts: (jobAttempts ?? 0) + 1,
    });
    throw err;
  } finally {
    // Cleanup temp file
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
