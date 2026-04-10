import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { workerClient } from './lib/worker-client';
import { deleteBookFiles } from './lib/r2-client';
import { isExcludedFromReadmigo } from './lib/curation-rules';

const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const DRY_RUN = args.includes('--dry-run');
const INPUT_FILE = getArg('input', '');
const OUTPUT_FILE = getArg('output', 'cleanup-review.json');

interface BookRow {
  id: string;
  gutenberg_id: number;
  title: string;
  author: string;
  subjects: string | null;
  status: string;
}

interface ExclusionEntry {
  bookId: string;
  gutenbergId: number;
  title: string;
  author: string;
  reason: string;
}

/**
 * Mode 1: --dry-run
 *   Scan all ready/approved books, output exclusion candidates to --output file.
 *   User reviews the JSON, removes false positives, then runs Mode 2.
 *
 * Mode 2: --input=reviewed.json
 *   Read reviewed exclusion list, execute: update status + delete R2 files.
 */
async function main() {
  if (INPUT_FILE) {
    await executeFromInput(INPUT_FILE);
  } else {
    await scanAndOutput();
  }
}

async function scanAndOutput() {
  console.log('='.repeat(60));
  console.log('PG Cleanup - Scan & generate exclusion list for review');
  console.log(`  Output: ${OUTPUT_FILE}`);
  console.log('='.repeat(60));

  const statuses = ['ready', 'approved'];
  const allBooks: BookRow[] = [];

  for (const status of statuses) {
    const { data } = await (workerClient as any).http.get('/internal/books', {
      params: { status, limit: 200 },
    });
    const books = Array.isArray(data) ? data : [];
    allBooks.push(...books);
  }

  console.log(`\nScanned ${allBooks.length} books.\n`);

  const candidates: ExclusionEntry[] = [];

  for (const book of allBooks) {
    const subjects = book.subjects ? JSON.parse(book.subjects) : [];
    const check = isExcludedFromReadmigo({ title: book.title, subjects });

    if (check.excluded) {
      candidates.push({
        bookId: book.id,
        gutenbergId: book.gutenberg_id,
        title: book.title,
        author: book.author,
        reason: check.reason || 'unknown',
      });
    }
  }

  console.log(`Found ${candidates.length} exclusion candidates (${allBooks.length - candidates.length} kept).\n`);

  for (const c of candidates) {
    console.log(`  PG#${c.gutenbergId} "${c.title}" by ${c.author} — ${c.reason}`);
  }

  const outputPath = path.resolve(OUTPUT_FILE);
  fs.writeFileSync(outputPath, JSON.stringify(candidates, null, 2));
  console.log(`\nSaved to ${outputPath}`);
  console.log('Review the file, remove books you want to KEEP, then run:');
  console.log(`  npx tsx scripts/pg-cleanup.ts --input=${OUTPUT_FILE}`);
}

async function executeFromInput(inputFile: string) {
  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const entries: ExclusionEntry[] = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  console.log('='.repeat(60));
  console.log('PG Cleanup - Execute reviewed exclusion list');
  console.log(`  Input: ${inputPath}`);
  console.log(`  Books to exclude: ${entries.length}`);
  console.log(`  Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  if (entries.length === 0) {
    console.log('No books to exclude.');
    return;
  }

  let excluded = 0;
  let r2Deleted = 0;

  for (const entry of entries) {
    console.log(`\n[exclude] PG#${entry.gutenbergId} "${entry.title}" — ${entry.reason}`);

    if (DRY_RUN) {
      excluded++;
      continue;
    }

    // 1. Delete R2 files
    try {
      const deleted = await deleteBookFiles(entry.gutenbergId);
      r2Deleted += deleted;
      console.log(`  R2: deleted ${deleted} files`);
    } catch (err) {
      console.error(`  R2 delete failed:`, err instanceof Error ? err.message : err);
    }

    // 2. Update status to 'excluded'
    try {
      await workerClient.updateBook(entry.bookId, { status: 'excluded' });
      console.log(`  DB: status -> excluded`);
    } catch (err) {
      console.error(`  DB update failed:`, err instanceof Error ? err.message : err);
    }

    excluded++;
  }

  console.log('\n' + '='.repeat(60));
  console.log('Cleanup Report');
  console.log(`  Excluded: ${excluded}`);
  if (!DRY_RUN) console.log(`  R2 files deleted: ${r2Deleted}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
