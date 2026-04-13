import 'dotenv/config';
import { fetchPage, GutendexBook, getEpubUrl } from './lib/gutendex-client';
import { workerClient } from './lib/worker-client';

/**
 * Discover Chinese books from Project Gutenberg via Gutendex API.
 * These are all verified public domain by PG's strict copyright review.
 * Queues them as jobs for the existing pg-process pipeline.
 */
async function main() {
  console.log('='.repeat(60));
  console.log('ZH Discover PG - Chinese books from Project Gutenberg');
  console.log('='.repeat(60));

  let page = 1;
  let total = 0;
  let queued = 0;
  let skipped = 0;
  let noEpub = 0;

  while (true) {
    console.log(`\nFetching page ${page}...`);
    const response = await fetchPage(page, 'zh');

    if (page === 1) console.log(`Total Chinese books on PG: ${response.count}`);

    for (const book of response.results) {
      total++;

      // Skip if no EPUB available
      if (!getEpubUrl(book)) {
        noEpub++;
        continue;
      }

      // Check if already exists in D1
      try {
        const existing = await workerClient.checkExistingBooks([book.id]);
        if (existing.length > 0) {
          skipped++;
          continue;
        }
      } catch {}

      // Create a processing job
      try {
        await workerClient.createJob(book.id, book.download_count || 0);
        queued++;
        const author = book.authors.map((a: any) => a.name).join(', ') || 'Unknown';
        console.log(`  + ${book.title.substring(0, 50)} / ${author} (PG#${book.id})`);
      } catch (e: any) {
        if (e?.response?.status === 409 || e?.message?.includes('UNIQUE')) {
          skipped++;
        } else {
          console.error(`  ! PG#${book.id}: ${e.message}`);
        }
      }
    }

    if (!response.next) break;
    page++;
  }

  console.log('\n' + '='.repeat(60));
  console.log('Discovery Complete');
  console.log(`  Found: ${total} | Queued: ${queued} | Skipped: ${skipped} | No EPUB: ${noEpub}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
