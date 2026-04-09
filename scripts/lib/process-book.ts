import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { v4 as uuid } from 'uuid';
import { workerClient } from './worker-client';
import { uploadEpub, uploadCover, uploadChapter, uploadImage } from './r2-client';
import { fetchBookById, getEpubUrl, GutendexBook } from './gutendex-client';
import { parseEpub, extractMetadata, extractChapters, extractCover, extractImages, ParsedChapter } from './epub-parser';
import { cleanChapterHtml } from './content-cleaner';
import { typographize } from './typographer';
import { modernizeSpelling } from './spelling-modernizer';
import { semanticize } from './semanticizer';
import { tagForeignPhrases } from './foreign-tagger';
import { checkBookQuality } from './quality-checker';
import { analyzeDifficulty } from './difficulty-analyzer';
import {
  extractIllustrationCaptions,
  buildImageMap,
  rewriteImagePaths,
  extractBase64Images,
  replaceBase64Placeholders,
  getImageFilename,
} from './image-processor';

// Pipeline version. Bump this whenever the end-to-end processing output
// changes in a way that makes previously stored records stale (e.g. parser
// fix, cleaner fix, new quality check that affects scoring). Books in D1
// whose `pipeline_version` is lower than this constant are candidates for
// reprocessing via POST /admin/books/reprocess.
//
// History:
//   0 — pre-versioning; broken multi-chapter-per-file parser
//   1 — P0 fixes: flow-based fallback, section-wrapped boilerplate removal,
//       duplication/word-ceiling quality checks
//   2 — B1.2: anchor-based chapter splitting, word-boundary skip filter
//   3 — P3.2: chapter titles extracted from in-body headings instead of
//       TOC labels (removes illustration-caption pollution)
export const PIPELINE_VERSION = 3;

// Strip HTML for word count (after cleaning)
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

export interface JobData {
  id: string;
  gutenbergId: number;
  status: string;
  priority: number;
  attempts: number;
  errorMessage?: string;
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

export async function processBook(gutenbergId: number, jobId?: string, jobAttempts?: number): Promise<ProcessResult> {
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
    //
    // The droplet's connection to www.gutenberg.org is intermittently
    // ETIMEDOUT during batch processing, while the pglaf mirror has been
    // consistently reachable for hundreds of downloads during calibration.
    // Always try pglaf first, then fall through to the original URL.
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

    tempFile = path.join(os.tmpdir(), `pg-${gutenbergId}-${Date.now()}.epub`);
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

    // Step 3b: Extract inline images from EPUB
    const epubImages = await extractImages(epub);
    console.log(`  Inline images: ${epubImages.length}`);

    // Step 4: Clean chapters
    console.log(`  [4/9] Cleaning chapter content...`);
    await updateJobSafe(jobId, { status: 'cleaning' });

    const cleanedChapters: Array<ParsedChapter & { cleanedHtml: string; cleanedWordCount: number }> = [];
    for (const ch of rawChapters) {
      // Extract illustration captions BEFORE cleaning removes [Illustration:] markers
      const captions = extractIllustrationCaptions(ch.htmlContent);

      // Extract base64 images before cleaning
      const { cleanedHtml: noBase64Html, images: base64Images } = extractBase64Images(ch.htmlContent);

      const cleaned = cleanChapterHtml(noBase64Html);
      const typographized = typographize(cleaned);
      const spellingFixed = modernizeSpelling(typographized);
      const semanticized = semanticize(spellingFixed);
      let finalHtml = tagForeignPhrases(semanticized);

      // Store base64 images and captions for later processing (after R2 upload)
      (ch as any)._captions = captions;
      (ch as any)._base64Images = base64Images;

      const cleanedWordCount = countWords(stripHtml(finalHtml));
      cleanedChapters.push({ ...ch, cleanedHtml: finalHtml, cleanedWordCount });
    }

    // Step 5: Calculate totals and quality check
    console.log(`  [5/9] Running quality check...`);
    const totalWordCount = cleanedChapters.reduce((sum, ch) => sum + ch.cleanedWordCount, 0);

    const quality = checkBookQuality(
      {
        title: metadata.title,
        chapterCount: cleanedChapters.length,
        wordCount: totalWordCount,
        hasCover: !!coverData,
        // Pass Gutendex subjects and the EPUB description so quality-checker
        // can apply the Readmigo curation rules as a second-line filter
        // (poetry / drama / multi-translator / preface-dominant).
        subjects: gutBook.subjects,
        description: metadata.description,
      },
      cleanedChapters.map(ch => ({
        title: ch.title,
        wordCount: ch.cleanedWordCount,
        htmlContent: ch.cleanedHtml,
      })),
    );

    console.log(`  Quality: score=${quality.score}, pass=${quality.pass}, tier=${quality.tier}`);
    if (quality.issues.length > 0) {
      console.log(`  Issues: ${quality.issues.join('; ')}`);
    }

    // Step 6: Difficulty analysis
    console.log(`  [6/9] Analyzing difficulty...`);
    const difficulty = analyzeDifficulty(
      cleanedChapters.map(ch => ch.cleanedHtml),
      totalWordCount,
    );
    console.log(`  Flesch: ${difficulty.fleschScore}, CEFR: ${difficulty.cefrLevel}, Difficulty: ${difficulty.difficultyScore}, Reading: ${difficulty.estimatedReadingMinutes}min`);

    // Step 7: Upload to R2
    console.log(`  [7/9] Uploading to R2...`);
    await updateJobSafe(jobId, { status: 'uploading' });

    const epubUrl2 = await uploadEpub(gutenbergId, Buffer.from(epubBuffer));
    console.log(`  Uploaded EPUB: ${epubUrl2}`);

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

    // Upload inline images and build path mapping
    const imageMapEntries: Array<{ href: string; r2Url: string }> = [];
    for (const img of epubImages) {
      const filename = getImageFilename(img.href);
      const r2Url = await uploadImage(gutenbergId, filename, img.data, img.mimeType);
      imageMapEntries.push({ href: img.href, r2Url });
    }
    const imageMap = buildImageMap(imageMapEntries);
    if (epubImages.length > 0) {
      console.log(`  Uploaded ${epubImages.length} inline images`);
    }

    // Rewrite image paths in chapter HTML and handle base64 images
    for (const ch of cleanedChapters) {
      const captions: string[] = (ch as any)._captions || [];
      const base64Images: Array<{ index: number; data: Buffer; mimeType: string; filename: string }> = (ch as any)._base64Images || [];

      // Upload base64 images and build placeholder→URL map
      const base64UrlMap = new Map<number, string>();
      for (const b64 of base64Images) {
        const r2Url = await uploadImage(gutenbergId, b64.filename, b64.data, b64.mimeType);
        base64UrlMap.set(b64.index, r2Url);
      }

      // Replace base64 placeholders
      if (base64UrlMap.size > 0) {
        ch.cleanedHtml = replaceBase64Placeholders(ch.cleanedHtml, base64UrlMap);
      }

      // Rewrite epub2-style image paths to R2 URLs and apply captions
      if (imageMap.size > 0 || captions.length > 0) {
        ch.cleanedHtml = rewriteImagePaths(ch.cleanedHtml, imageMap, captions);
      }
    }

    // Upload chapters with generated UUIDs
    const chapterEntries: Array<{ id: string; orderNum: number; title: string; contentUrl: string; wordCount: number; qualityOk: number }> = [];
    for (const ch of cleanedChapters) {
      const chapterId = uuid();
      const contentUrl = await uploadChapter(gutenbergId, chapterId, ch.cleanedHtml);
      chapterEntries.push({
        id: chapterId,
        orderNum: ch.order,
        title: ch.title,
        contentUrl,
        wordCount: ch.cleanedWordCount,
        qualityOk: ch.cleanedWordCount >= 50 ? 1 : 0,
      });
    }
    console.log(`  Uploaded ${chapterEntries.length} chapters`);

    // Step 8: Write to D1 via Worker API
    console.log(`  [8/9] Creating book record...`);
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
      language: metadata.language,
      subjects: JSON.stringify(gutBook.subjects),
      description: metadata.description || null,
      coverUrl: coverUrl,
      epubUrl: epubUrl2,
      sourceUrl: sourceUrl,
      status: bookStatus,
      qualityScore: quality.score,
      qualityIssues: JSON.stringify(quality.issues),
      chapterCount: chapterEntries.length,
      wordCount: totalWordCount,
      fleschScore: difficulty.fleschScore,
      cefrLevel: difficulty.cefrLevel,
      difficultyScore: difficulty.difficultyScore,
      estimatedReadingMinutes: difficulty.estimatedReadingMinutes,
      coverSource: coverSource,
      pipelineVersion: PIPELINE_VERSION,
    });

    // Use the actual DB id (may differ from uuid() if book already existed)
    const bookId = bookRecord.id;
    console.log(`  Book record saved: id=${bookId}, inserting ${chapterEntries.length} chapters...`);

    // Skip the chapter insert when the parser produced zero usable chapters.
    // The worker's createChapters route rejects empty arrays with 400, which
    // otherwise surfaces as a pipeline failure even though the book is just
    // an extraction edge case that should be marked rejected. The book
    // record itself is already persisted above with chapterCount=0 and the
    // quality-checker has pushed the score below the rejected threshold.
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

    // Step 9: Mark job done
    console.log(`  [9/9] Done!`);
    await updateJobSafe(jobId, { status: 'done' });

    return {
      bookId,
      gutenbergId,
      title: metadata.title,
      chapterCount: chapterEntries.length,
      wordCount: totalWordCount,
      qualityScore: quality.score,
      qualityPass: quality.pass,
      qualityTier: quality.tier,
      fleschScore: difficulty.fleschScore,
      cefrLevel: difficulty.cefrLevel,
      difficultyScore: difficulty.difficultyScore,
      estimatedReadingMinutes: difficulty.estimatedReadingMinutes,
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
