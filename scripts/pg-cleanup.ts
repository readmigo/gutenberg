import 'dotenv/config';
import { workerClient } from './lib/worker-client';
import { deleteBookFiles } from './lib/r2-client';
import { isExcludedFromReadmigo } from './lib/curation-rules';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

interface BookRow {
  id: string;
  gutenberg_id: number;
  title: string;
  author: string;
  subjects: string | null;
  status: string;
}

async function main() {
  console.log('='.repeat(60));
  console.log('PG Cleanup - Re-evaluate existing books against curation rules');
  console.log(`  Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  // Fetch all ready/approved books
  const statuses = ['ready', 'approved'];
  const allBooks: BookRow[] = [];

  for (const status of statuses) {
    const { data } = await (workerClient as any).http.get('/internal/books', {
      params: { status, limit: 200 },
    });
    const books = Array.isArray(data) ? data : [];
    allBooks.push(...books);
  }

  console.log(`\nFound ${allBooks.length} books with ready/approved status.\n`);

  let excluded = 0;
  let kept = 0;
  let r2Deleted = 0;
  const excludedBooks: Array<{ id: number; title: string; reason: string }> = [];

  for (const book of allBooks) {
    const subjects = book.subjects ? JSON.parse(book.subjects) : [];
    const check = isExcludedFromReadmigo({
      title: book.title,
      subjects,
    });

    if (!check.excluded) {
      kept++;
      continue;
    }

    excludedBooks.push({
      id: book.gutenberg_id,
      title: book.title,
      reason: check.reason || 'unknown',
    });

    console.log(`[exclude] PG#${book.gutenberg_id} "${book.title}" — ${check.reason}`);

    if (DRY_RUN) {
      excluded++;
      continue;
    }

    // 1. Delete R2 files
    try {
      const deleted = await deleteBookFiles(book.gutenberg_id);
      r2Deleted += deleted;
      console.log(`  R2: deleted ${deleted} files`);
    } catch (err) {
      console.error(`  R2 delete failed:`, err instanceof Error ? err.message : err);
    }

    // 2. Update status to 'excluded'
    try {
      await workerClient.updateBook(book.id, { status: 'excluded' });
      console.log(`  DB: status -> excluded`);
    } catch (err) {
      console.error(`  DB update failed:`, err instanceof Error ? err.message : err);
    }

    excluded++;
  }

  // Print report
  console.log('\n' + '='.repeat(60));
  console.log('Cleanup Report');
  console.log(`  Total scanned: ${allBooks.length}`);
  console.log(`  Kept: ${kept}`);
  console.log(`  Excluded: ${excluded}`);
  if (!DRY_RUN) console.log(`  R2 files deleted: ${r2Deleted}`);
  console.log('='.repeat(60));

  if (excludedBooks.length > 0) {
    console.log('\nExcluded books:');
    for (const b of excludedBooks) {
      console.log(`  PG#${b.id} "${b.title}" — ${b.reason}`);
    }
  }
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
