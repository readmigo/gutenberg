import 'dotenv/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { v4 as uuid } from 'uuid';
import * as cheerio from 'cheerio';
import { workerClient } from './lib/worker-client';
import { uploadChapter } from './lib/r2-client';
import { parseEpub, extractMetadata, extractChapters, extractCover } from './lib/epub-parser';
import { traditionalToSimplified, isTraditional } from './lib/opencc';
import { detectChapters } from './lib/zh-chapter-detector';
import { needsPunctuation, addPunctuation } from './lib/zh-punctuation';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const sourceArg = getArg('source', 'all') as 'haodoo' | 'wenshuoge' | 'all';
const limit = parseInt(getArg('limit', '20'), 10);

const BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:8787';
const INTERNAL_KEY = process.env.WORKER_INTERNAL_KEY || '';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

let isShuttingDown = false;

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  isShuttingDown = true;
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  isShuttingDown = true;
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface ZhSource {
  id: number;
  sourceType: string;
  sourceBookId: string;
  downloadUrl: string;
  status: string;
  title?: string;
  author?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtmlForCount(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** For Chinese text, character count ≈ word count. */
function countChars(text: string): number {
  return text.replace(/\s/g, '').length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchSources(sourceType: string, limitN: number): Promise<ZhSource[]> {
  const params: Record<string, string | number> = { status: 'downloaded', limit: limitN };
  if (sourceType !== 'all') {
    params.source_type = sourceType;
  }
  const response = await (workerClient as any).http.get('/api/zh/sources', { params });
  const data = response.data;
  return Array.isArray(data) ? data : (data.sources ?? []);
}

async function updateSourceStatus(id: number, status: string, error?: string): Promise<void> {
  const body: Record<string, string> = { status };
  if (error) body.error = error;
  await (workerClient as any).http.put(`/api/zh/sources/${id}`, body);
}

// ─── R2 download ──────────────────────────────────────────────────────────────

async function downloadEpubFromR2(sourceType: string, sourceBookId: string): Promise<Buffer> {
  const key = `zh-raw/${sourceType}/${sourceBookId}.epub`;

  // Try R2 public URL first
  if (R2_PUBLIC_URL) {
    try {
      const url = `${R2_PUBLIC_URL}/${key}`;
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: 100 * 1024 * 1024,
      });
      return Buffer.from(resp.data);
    } catch {
      // Fall through to worker endpoint
    }
  }

  // Fallback: Worker public content endpoint (/content/*)
  const resp = await axios.get(`${BASE_URL}/content/${key}`, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: 100 * 1024 * 1024,
  });
  return Buffer.from(resp.data);
}

// ─── Cover upload ─────────────────────────────────────────────────────────────

async function uploadCoverToR2(bookId: number, data: Buffer, mimeType: string): Promise<string> {
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  const key = `covers/zh-${bookId}.${ext}`;

  await axios.put(`${BASE_URL}/internal/r2/${key}`, data, {
    headers: {
      'X-Internal-Key': INTERNAL_KEY,
      'Content-Type': mimeType,
    },
    timeout: 60000,
    maxBodyLength: 20 * 1024 * 1024,
  });

  return R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : key;
}

// ─── Chapter HTML cleaning ────────────────────────────────────────────────────

function cleanChapterHtml(html: string): string {
  const $ = cheerio.load(html, { xmlMode: false });
  $('script, style, link').remove();
  return $.html();
}

// ─── Split monolithic chapter by detected headings ────────────────────────────

interface SplitChapter {
  order: number;
  title: string;
  htmlContent: string;
  charCount: number;
}

function splitLargeChapter(html: string): SplitChapter[] | null {
  const detected = detectChapters(html);
  if (detected.length < 2) return null;

  const chapters: SplitChapter[] = [];
  for (let i = 0; i < detected.length; i++) {
    const start = detected[i].index;
    const end = i + 1 < detected.length ? detected[i + 1].index : html.length;
    const segment = html.slice(start, end);
    const text = stripHtmlForCount(segment);
    const charCount = countChars(text);
    if (charCount < 50) continue;
    chapters.push({
      order: chapters.length + 1,
      title: detected[i].title,
      htmlContent: segment,
      charCount,
    });
  }
  return chapters.length > 1 ? chapters : null;
}

// ─── Process a single source book ────────────────────────────────────────────

async function processSource(source: ZhSource, idx: number, total: number): Promise<void> {
  const label = `[${idx + 1}/${total}] ${source.sourceType}/${source.sourceBookId}`;
  const titleStr = source.title ? ` "${source.title}"` : '';
  console.log(`\n${label}${titleStr}`);

  let tempFile: string | null = null;

  try {
    // Step 1: Download EPUB from R2
    console.log(`  [1] Downloading EPUB from R2...`);
    const epubBuffer = await downloadEpubFromR2(source.sourceType, source.sourceBookId);
    console.log(`  [1] Downloaded ${(epubBuffer.length / 1024).toFixed(1)} KB`);

    // Step 2: Save to temp file and parse
    console.log(`  [2] Parsing EPUB...`);
    tempFile = path.join(os.tmpdir(), `zh-clean-${uuid()}.epub`);
    fs.writeFileSync(tempFile, epubBuffer);

    const epub = await parseEpub(tempFile);
    const metadata = extractMetadata(epub);
    const parsedChapters = await extractChapters(epub);
    const coverData = await extractCover(epub);

    console.log(`  [2] Title: "${metadata.title}", Chapters: ${parsedChapters.length}`);

    if (parsedChapters.length === 0) {
      throw new Error('No chapters extracted from EPUB');
    }

    // Step 3: Detect script (Traditional vs Simplified)
    const sampleText = parsedChapters
      .slice(0, 3)
      .map((ch) => stripHtmlForCount(ch.htmlContent))
      .join(' ')
      .slice(0, 2000);

    const originalScript = isTraditional(sampleText) ? 'traditional' : 'simplified';
    console.log(`  [3] Script detected: ${originalScript}`);

    // Step 4: Process each chapter
    console.log(`  [4] Processing ${parsedChapters.length} chapters...`);
    let punctuationAdded = false;

    interface ProcessedChapter {
      order: number;
      title: string;
      htmlContent: string;
      charCount: number;
    }

    const processedChapters: ProcessedChapter[] = [];

    for (const ch of parsedChapters) {
      // Strip script/style/link tags
      let html = cleanChapterHtml(ch.htmlContent);

      // Convert Traditional Chinese if needed
      if (originalScript === 'traditional') {
        html = traditionalToSimplified(html);
      }

      // Check and add punctuation via LLM
      const plainText = stripHtmlForCount(html);
      if (needsPunctuation(plainText)) {
        console.log(`    Chapter "${ch.title}" needs punctuation, calling LLM...`);
        const punctuated = await addPunctuation(plainText);
        // Wrap result back in a simple paragraph structure
        html = `<p>${punctuated.replace(/\n/g, '</p><p>')}</p>`;
        punctuationAdded = true;
      }

      const charCount = countChars(stripHtmlForCount(html));
      processedChapters.push({
        order: ch.order,
        title: ch.title,
        htmlContent: html,
        charCount,
      });
    }

    // Step 5: If only 1 large chapter (>10000 chars), try to split
    let finalChapters: ProcessedChapter[] = processedChapters;

    if (processedChapters.length === 1 && processedChapters[0].charCount > 10000) {
      console.log(`  [5] Single large chapter (${processedChapters[0].charCount} chars), attempting split...`);
      const splitResult = splitLargeChapter(processedChapters[0].htmlContent);
      if (splitResult && splitResult.length > 1) {
        finalChapters = splitResult;
        console.log(`  [5] Split into ${finalChapters.length} chapters`);
      } else {
        console.log(`  [5] Could not split, keeping as single chapter`);
      }
    }

    // Step 6: Upload chapters to R2 (use negative source.id as gutenbergId namespace)
    console.log(`  [6] Uploading ${finalChapters.length} chapters to R2...`);
    const gutenbergId = -(source.id); // Negative ID to avoid collision with English books

    const chapterEntries: Record<string, unknown>[] = [];
    for (const ch of finalChapters) {
      const chapterId = uuid();
      const contentUrl = await uploadChapter(gutenbergId, chapterId, ch.htmlContent);
      chapterEntries.push({
        id: chapterId,
        orderNum: ch.order,
        title: ch.title,
        contentUrl,
        wordCount: ch.charCount, // charCount used as wordCount equivalent for Chinese
        qualityOk: ch.charCount >= 50 ? 1 : 0,
      });
    }
    console.log(`  [6] Uploaded ${chapterEntries.length} chapters`);

    // Step 7: Upload cover if present
    let coverUrl: string | null = null;
    if (coverData) {
      console.log(`  [7] Uploading cover...`);
      coverUrl = await uploadCoverToR2(source.id, coverData.data, coverData.mimeType);
      console.log(`  [7] Cover uploaded`);
    }

    // Step 8: Create book record
    console.log(`  [8] Creating book record...`);
    const totalCharCount = chapterEntries.reduce((sum, ch) => sum + (ch.wordCount as number), 0);

    const bookRecord = await workerClient.createBook({
      id: uuid(),
      gutenbergId: gutenbergId,
      title: metadata.title || source.title || 'Unknown',
      author: metadata.author || source.author || 'Unknown',
      language: 'zh',
      subjects: JSON.stringify([]),
      description: metadata.description || null,
      coverUrl,
      sourceUrl: null,
      status: 'pending',
      chapterCount: chapterEntries.length,
      wordCount: totalCharCount,
      sourceType: source.sourceType,
      originalScript,
      punctuationAdded: punctuationAdded ? 1 : 0,
      zhSourceId: source.id,
      pipelineVersion: 1,
    });

    const bookId = bookRecord.id;
    console.log(`  [8] Book record saved: id=${bookId}`);

    // Step 9: Create chapters
    console.log(`  [9] Creating ${chapterEntries.length} chapter records...`);
    if (chapterEntries.length > 0) {
      await workerClient.createChapters(bookId, chapterEntries);
    }
    console.log(`  [9] Chapters saved`);

    // Step 10: Mark source as cleaned
    await updateSourceStatus(source.id, 'cleaned');
    console.log(`  -> done (${totalCharCount} chars, ${chapterEntries.length} chapters)\n`);

  } finally {
    // Cleanup temp file
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('ZH Clean - Chinese EPUB Processing Script');
  console.log('='.repeat(60));
  console.log(`  Source: ${sourceArg}`);
  console.log(`  Limit:  ${limit}`);
  console.log('');

  let sources: ZhSource[];
  try {
    sources = await fetchSources(sourceArg, limit);
  } catch (err) {
    console.error('Failed to fetch sources:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (sources.length === 0) {
    console.log(`No sources with status='downloaded' found. Nothing to do.`);
    return;
  }

  console.log(`Found ${sources.length} source(s) to process.\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < sources.length; i++) {
    if (isShuttingDown) {
      console.log('Shutdown requested, stopping early.');
      break;
    }

    const source = sources[i];

    try {
      await processSource(source, i, sources.length);
      successCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  -> FAILED: ${message}\n`);
      try {
        await updateSourceStatus(source.id, 'failed', message);
      } catch (updateErr) {
        console.error(
          `  (also failed to update status: ${updateErr instanceof Error ? updateErr.message : updateErr})`,
        );
      }
      failCount++;
    }

    // Small delay between books (skip after last)
    if (i < sources.length - 1 && !isShuttingDown) {
      await sleep(1000);
    }
  }

  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`  Total:   ${sources.length}`);
  console.log(`  Success: ${successCount}`);
  console.log(`  Failed:  ${failCount}`);
}

main().catch((err) => {
  console.error('Process failed:', err);
  process.exit(1);
});
