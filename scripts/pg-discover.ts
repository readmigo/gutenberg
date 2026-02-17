import 'dotenv/config';
import { fetchPage, getEpubUrl } from './lib/gutendex-client';
import { workerClient } from './lib/worker-client';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const DISCOVER_LIMIT = parseInt(getArg('discover-limit', '50'));
const MIN_DOWNLOADS = parseInt(getArg('min-downloads', '100'));
const DRY_RUN = args.includes('--dry-run');

async function main() {
  console.log('='.repeat(60));
  console.log('PG Discover - Hot-First Strategy');
  console.log(`  Limit: ${DISCOVER_LIMIT} | Min downloads: ${MIN_DOWNLOADS} | Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  let discovered = 0;
  let skipped = 0;
  let consecutiveAllExist = 0;
  let page = 1;

  while (discovered < DISCOVER_LIMIT) {
    console.log(`\nPage ${page}...`);

    let response;
    try {
      response = await fetchPage(page);
    } catch (err) {
      console.error(`  Failed to fetch page ${page}:`, err instanceof Error ? err.message : err);
      break;
    }

    if (response.results.length === 0) {
      console.log('  No more results.');
      break;
    }

    // Filter: has EPUB, meets min downloads
    const candidates = response.results.filter((b) => getEpubUrl(b) && b.download_count >= MIN_DOWNLOADS);

    if (candidates.length === 0) {
      console.log('  No candidates on this page (below min downloads threshold).');
      break; // Gutendex sorts by download_count DESC, later pages will be even lower
    }

    // Check which already exist
    const gutenbergIds = candidates.map((b) => b.id);
    let existingIds: number[] = [];
    try {
      existingIds = await workerClient.checkExistingBooks(gutenbergIds);
    } catch (err) {
      console.error('  Failed to check existing books:', err instanceof Error ? err.message : err);
      break;
    }

    const existingSet = new Set(existingIds);
    const newBooks = candidates.filter((b) => !existingSet.has(b.id));

    console.log(`  Found ${candidates.length} candidates, ${newBooks.length} new, ${existingSet.size} existing`);

    if (newBooks.length === 0) {
      consecutiveAllExist++;
      if (consecutiveAllExist >= 3) {
        console.log('\n  3 consecutive pages with no new books. Stopping.');
        break;
      }
    } else {
      consecutiveAllExist = 0;
    }

    // Create jobs for new books
    for (const book of newBooks) {
      if (discovered >= DISCOVER_LIMIT) break;

      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would create job: ${book.title} (DL: ${book.download_count})`);
      } else {
        try {
          await workerClient.createJob(book.id, book.download_count);
          console.log(`  Created job: ${book.title} (DL: ${book.download_count})`);
        } catch (err) {
          console.error(`  Failed to create job for ${book.title}:`, err instanceof Error ? err.message : err);
          continue;
        }
      }
      discovered++;
    }

    skipped += existingSet.size;
    page++;

    // Small delay between pages
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Summary: ${discovered} discovered, ${skipped} skipped, ${page - 1} pages scanned`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Discover failed:', err);
  process.exit(1);
});
