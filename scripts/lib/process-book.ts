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
import { checkBookQuality } from './quality-checker';

export interface JobData {
  id: string;
  gutenberg_id: number;
  status: string;
  priority: number;
  attempts: number;
  error_message?: string;
}

export interface ProcessResult {
  bookId: string;
  gutenbergId: number;
  title: string;
  chapterCount: number;
  wordCount: number;
  qualityScore: number;
  qualityPass: boolean;
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
    console.log(`  [1/8] Fetching Gutendex metadata for ID ${gutenbergId}...`);
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

    // Step 2: Download EPUB (with retry)
    console.log(`  [2/8] Downloading EPUB...`);
    let epubBuffer: Buffer;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await axios.get<Buffer>(epubUrl, {
          responseType: 'arraybuffer',
          timeout: 120000,
          maxRedirects: 5,
        });
        epubBuffer = resp.data;
        break;
      } catch (dlErr: any) {
        const msg = dlErr?.message || dlErr?.code || JSON.stringify(dlErr);
        console.error(`  Download attempt ${attempt}/3 failed: ${msg}`);
        if (attempt === 3) throw new Error(`EPUB download failed after 3 attempts: ${msg}`);
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }

    tempFile = path.join(os.tmpdir(), `pg-${gutenbergId}-${Date.now()}.epub`);
    fs.writeFileSync(tempFile, epubBuffer);
    console.log(`  Downloaded ${(epubBuffer.length / 1024).toFixed(1)} KB -> ${tempFile}`);

    // Step 3: Parse EPUB
    console.log(`  [3/8] Parsing EPUB...`);
    await updateJobSafe(jobId, { status: 'parsing' });

    const epub = await parseEpub(tempFile);
    const metadata = extractMetadata(epub);
    const rawChapters = await extractChapters(epub);
    const coverData = await extractCover(epub);

    console.log(`  Metadata: ${metadata.title} by ${metadata.author}`);
    console.log(`  Raw chapters: ${rawChapters.length}, Cover: ${coverData ? 'yes' : 'no'}`);

    // Step 4: Clean chapters
    console.log(`  [4/8] Cleaning chapter content...`);
    await updateJobSafe(jobId, { status: 'cleaning' });

    const cleanedChapters: Array<ParsedChapter & { cleanedHtml: string }> = [];
    for (const ch of rawChapters) {
      const cleanedHtml = cleanChapterHtml(ch.htmlContent);
      cleanedChapters.push({ ...ch, cleanedHtml });
    }

    // Step 5: Calculate totals and quality check
    console.log(`  [5/8] Running quality check...`);
    const totalWordCount = cleanedChapters.reduce((sum, ch) => sum + ch.wordCount, 0);

    const quality = checkBookQuality(
      {
        title: metadata.title,
        chapterCount: cleanedChapters.length,
        wordCount: totalWordCount,
        hasCover: !!coverData,
      },
      cleanedChapters.map(ch => ({
        title: ch.title,
        wordCount: ch.wordCount,
        htmlContent: ch.cleanedHtml,
      })),
    );

    console.log(`  Quality: score=${quality.score}, pass=${quality.pass}`);
    if (quality.issues.length > 0) {
      console.log(`  Issues: ${quality.issues.join('; ')}`);
    }

    // Step 6: Upload to R2
    console.log(`  [6/8] Uploading to R2...`);
    await updateJobSafe(jobId, { status: 'uploading' });

    const epubUrl2 = await uploadEpub(gutenbergId, Buffer.from(epubBuffer));
    console.log(`  Uploaded EPUB: ${epubUrl2}`);

    let coverUrl: string | null = null;
    if (coverData) {
      coverUrl = await uploadCover(gutenbergId, coverData.data, coverData.mimeType);
      console.log(`  Uploaded cover: ${coverUrl}`);
    }

    // Upload chapters with generated UUIDs
    const chapterEntries: Array<{ id: string; orderNum: number; title: string; contentUrl: string; wordCount: number }> = [];
    for (const ch of cleanedChapters) {
      const chapterId = uuid();
      const contentUrl = await uploadChapter(gutenbergId, chapterId, ch.cleanedHtml);
      chapterEntries.push({
        id: chapterId,
        orderNum: ch.order,
        title: ch.title,
        contentUrl,
        wordCount: ch.wordCount,
      });
    }
    console.log(`  Uploaded ${chapterEntries.length} chapters`);

    // Step 7: Write to D1 via Worker API
    console.log(`  [7/8] Creating book record...`);
    const bookId = uuid();
    const author = gutBook.authors.map(a => a.name).join(', ') || metadata.author;
    const sourceUrl = `https://www.gutenberg.org/ebooks/${gutenbergId}`;

    await workerClient.createBook({
      id: bookId,
      gutenbergId: gutenbergId,
      title: metadata.title,
      author,
      language: metadata.language,
      subjects: JSON.stringify(gutBook.subjects),
      description: metadata.description || null,
      coverUrl: coverUrl,
      epubUrl: epubUrl2,
      sourceUrl: sourceUrl,
      status: quality.pass ? 'ready' : 'pending',
      qualityScore: quality.score,
      qualityIssues: JSON.stringify(quality.issues),
      chapterCount: chapterEntries.length,
      wordCount: totalWordCount,
    });

    await workerClient.createChapters(
      bookId,
      chapterEntries.map(ch => ({
        id: ch.id,
        orderNum: ch.orderNum,
        title: ch.title,
        contentUrl: ch.contentUrl,
        wordCount: ch.wordCount,
        qualityOk: 1,
      })),
    );

    // Step 8: Mark job done
    console.log(`  [8/8] Done!`);
    await updateJobSafe(jobId, { status: 'done' });

    return {
      bookId,
      gutenbergId,
      title: metadata.title,
      chapterCount: chapterEntries.length,
      wordCount: totalWordCount,
      qualityScore: quality.score,
      qualityPass: quality.pass,
    };
  } catch (err) {
    // Update job to failed
    const errorMessage = err instanceof Error ? err.message : String(err);
    await updateJobSafe(jobId, {
      status: 'failed',
      error_message: errorMessage,
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
