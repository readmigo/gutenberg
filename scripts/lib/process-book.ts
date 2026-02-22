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
import {
  extractIllustrationCaptions,
  buildImageMap,
  rewriteImagePaths,
  extractBase64Images,
  replaceBase64Placeholders,
  getImageFilename,
} from './image-processor';

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
    let epubBuffer!: Buffer;
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

    // Step 3b: Extract inline images from EPUB
    const epubImages = await extractImages(epub);
    console.log(`  Inline images: ${epubImages.length}`);

    // Step 4: Clean chapters
    console.log(`  [4/8] Cleaning chapter content...`);
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
    console.log(`  [5/8] Running quality check...`);
    const totalWordCount = cleanedChapters.reduce((sum, ch) => sum + ch.cleanedWordCount, 0);

    const quality = checkBookQuality(
      {
        title: metadata.title,
        chapterCount: cleanedChapters.length,
        wordCount: totalWordCount,
        hasCover: !!coverData,
      },
      cleanedChapters.map(ch => ({
        title: ch.title,
        wordCount: ch.cleanedWordCount,
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

    // Step 7: Write to D1 via Worker API
    console.log(`  [7/8] Creating book record...`);
    const author = gutBook.authors.map(a => a.name).join(', ') || metadata.author;
    const sourceUrl = `https://www.gutenberg.org/ebooks/${gutenbergId}`;

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
      status: quality.pass ? 'ready' : 'pending',
      qualityScore: quality.score,
      qualityIssues: JSON.stringify(quality.issues),
      chapterCount: chapterEntries.length,
      wordCount: totalWordCount,
    });

    // Use the actual DB id (may differ from uuid() if book already existed)
    const bookId = bookRecord.id;

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
