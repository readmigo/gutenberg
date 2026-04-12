import 'dotenv/config';
import axios from 'axios';
import { workerClient } from './lib/worker-client';

/**
 * Final validation script for Chinese books.
 *
 * Validates enriched Chinese books and transitions them to:
 *   - status='processed'  (qualityScore=80) if all checks pass
 *   - status='rejected'   (qualityScore=30) if any check fails
 *
 * CLI args:
 *   --limit=N   Max books to process (default: 100)
 *
 * Required env vars:
 *   WORKER_BASE_URL      - Worker API base URL
 *   WORKER_INTERNAL_KEY  - Internal auth key
 */

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const LIMIT = parseInt(getArg('limit', '100'), 10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ZhBook {
  id: string;
  title: string;
  author: string;
  coverUrl?: string | null;
  coverPrompt?: string | null;
  chapterCount?: number | null;
  wordCount?: number | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateBook(book: ZhBook): string[] {
  const issues: string[] = [];

  if (!book.title || book.title === 'Unknown') {
    issues.push('missing_title');
  }

  if (!book.author || book.author === '未知') {
    issues.push('missing_author');
  }

  const chapterCount = book.chapterCount ?? 0;
  if (chapterCount < 1) {
    issues.push('no_chapters');
  }

  const wordCount = book.wordCount ?? 0;
  if (wordCount < 1000) {
    issues.push('insufficient_word_count');
  }

  if (!book.coverUrl && !book.coverPrompt) {
    issues.push('missing_cover');
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60));
  console.log('ZH Process - Final Validation');
  console.log(`  Limit: ${LIMIT}`);
  console.log('='.repeat(60));

  // 1. Fetch enriched Chinese books
  console.log('\nFetching enriched Chinese books...');
  let books: ZhBook[];
  try {
    const { data } = await (workerClient as any).http.get('/api/zh/books', {
      params: { status: 'enriched', limit: LIMIT },
    });
    books = Array.isArray(data) ? data : data.books || [];
  } catch (err) {
    console.error('Failed to fetch books:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (books.length === 0) {
    console.log('No enriched books found. All done!');
    return;
  }

  console.log(`Found ${books.length} book(s) to validate.\n`);

  let processed = 0;
  let rejected = 0;

  for (const book of books) {
    console.log(`Validating: ${book.title} / ${book.author} [${book.id}]`);

    const issues = validateBook(book);
    const pass = issues.length === 0;

    try {
      if (pass) {
        await (workerClient as any).http.patch(`/api/zh/books/${book.id}`, {
          status: 'processed',
          qualityScore: 80,
          qualityIssues: JSON.stringify([]),
        });
        console.log('  -> PASS: status=processed');
        processed++;
      } else {
        await (workerClient as any).http.patch(`/api/zh/books/${book.id}`, {
          status: 'rejected',
          qualityScore: 30,
          qualityIssues: JSON.stringify(issues),
        });
        console.log(`  -> FAIL: status=rejected, issues=[${issues.join(', ')}]`);
        rejected++;
      }
    } catch (err) {
      console.error(`  -> ERROR updating book: ${err instanceof Error ? err.message : err}`);
    }

    console.log('');
  }

  console.log('='.repeat(60));
  console.log('ZH Process Complete');
  console.log(`  Processed: ${processed}`);
  console.log(`  Rejected:  ${rejected}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('ZH Process failed:', err);
  process.exit(1);
});
