import 'dotenv/config';
import axios from 'axios';
import { workerClient } from './lib/worker-client';

/**
 * Quality report & correction flagging script for Chinese books.
 *
 * Performs deeper quality checks on processed Chinese books:
 *   - CJK character ratio (< 50% of non-whitespace chars → flagged)
 *   - Average chapter length (wordCount / chapterCount < 200 → flagged)
 *   - Content fetch errors → flagged
 *
 * Books with any issue get PATCH needsCorrection=1, qualityIssues=JSON.stringify(issues)
 *
 * CLI args:
 *   --limit=N   Max books to process (default: 200)
 *
 * Required env vars:
 *   WORKER_BASE_URL      - Worker API base URL
 *   WORKER_INTERNAL_KEY  - Internal auth key
 *   R2_PUBLIC_URL        - Public base URL for R2 assets (for resolving relative content URLs)
 */

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const LIMIT = parseInt(getArg('limit', '200'), 10);

const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ZhBook {
  id: string;
  title: string;
  author: string;
  chapterCount?: number | null;
  wordCount?: number | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a potentially relative content URL to an absolute URL.
 */
function resolveContentUrl(contentUrl: string): string {
  if (contentUrl.startsWith('http://') || contentUrl.startsWith('https://')) {
    return contentUrl;
  }
  const path = contentUrl.startsWith('/') ? contentUrl : `/${contentUrl}`;
  return `${R2_PUBLIC_URL}${path}`;
}

/**
 * Count CJK characters in a string.
 * Covers CJK Unified Ideographs (U+4E00–U+9FFF) and Extension A (U+3400–U+4DBF).
 */
function countCjkChars(text: string): number {
  const matches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  return matches ? matches.length : 0;
}

/**
 * Count non-whitespace characters in a string.
 */
function countNonWhitespace(text: string): number {
  const matches = text.match(/\S/g);
  return matches ? matches.length : 0;
}

/**
 * Fetch text content from the first chapter of a book.
 * Returns null if fetching fails.
 */
async function fetchFirstChapterText(bookId: string): Promise<string | null> {
  const { data: chaptersData } = await (workerClient as any).http.get(
    `/internal/books/${bookId}/chapters`,
  );
  const chapters = Array.isArray(chaptersData)
    ? chaptersData
    : chaptersData.chapters || [];

  if (chapters.length === 0) return null;

  const firstChapter = chapters[0];
  const rawUrl: string | undefined = firstChapter.content_url || firstChapter.contentUrl;
  if (!rawUrl) return null;

  const absoluteUrl = resolveContentUrl(rawUrl);

  const { data: html } = await axios.get(absoluteUrl, { timeout: 10000 });
  const text = (html as string)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, 5000);
}

// ---------------------------------------------------------------------------
// Quality checks
// ---------------------------------------------------------------------------

async function checkBook(book: ZhBook): Promise<string[]> {
  const issues: string[] = [];

  // a. Fetch first chapter content
  let text: string | null = null;
  try {
    text = await fetchFirstChapterText(book.id);
  } catch {
    issues.push('content_fetch_error');
    return issues;
  }

  if (text !== null) {
    // b. CJK character ratio check
    const nonWsCount = countNonWhitespace(text);
    if (nonWsCount > 0) {
      const cjkCount = countCjkChars(text);
      const cjkRatio = cjkCount / nonWsCount;
      if (cjkRatio < 0.5) {
        issues.push('low_cjk_ratio');
      }
    }
  }

  // c. Average chapter length check
  const wordCount = book.wordCount ?? 0;
  const chapterCount = book.chapterCount ?? 0;
  if (chapterCount > 0) {
    const avgChapterLength = wordCount / chapterCount;
    if (avgChapterLength < 200) {
      issues.push('short_chapters');
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60));
  console.log('ZH Quality - Quality Report & Correction Flagging');
  console.log(`  Limit: ${LIMIT}`);
  console.log('='.repeat(60));

  // 1. Fetch processed Chinese books
  console.log('\nFetching processed Chinese books...');
  let books: ZhBook[];
  try {
    const { data } = await (workerClient as any).http.get('/api/zh/books', {
      params: { status: 'processed', limit: LIMIT },
    });
    books = Array.isArray(data) ? data : data.books || [];
  } catch (err) {
    console.error('Failed to fetch books:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (books.length === 0) {
    console.log('No processed books found. All done!');
    return;
  }

  console.log(`Found ${books.length} book(s) to check.\n`);

  let clean = 0;
  let flagged = 0;

  for (const book of books) {
    console.log(`Checking: ${book.title} / ${book.author} [${book.id}]`);

    const issues = await checkBook(book);

    try {
      if (issues.length > 0) {
        await (workerClient as any).http.patch(`/api/zh/books/${book.id}`, {
          needsCorrection: 1,
          qualityIssues: JSON.stringify(issues),
        });
        console.log(`  -> FLAGGED: issues=[${issues.join(', ')}]`);
        flagged++;
      } else {
        console.log('  -> CLEAN');
        clean++;
      }
    } catch (err) {
      console.error(`  -> ERROR updating book: ${err instanceof Error ? err.message : err}`);
    }

    console.log('');
  }

  console.log('='.repeat(60));
  console.log('ZH Quality Complete');
  console.log(`  Clean:   ${clean}`);
  console.log(`  Flagged: ${flagged}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('ZH Quality failed:', err);
  process.exit(1);
});
