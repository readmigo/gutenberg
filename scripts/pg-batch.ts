import 'dotenv/config';
import { workerClient } from './lib/worker-client';
import { processBook, JobData } from './lib/process-book';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const MAX_BOOKS = parseInt(getArg('max-books', '10'));
const DELAY_MS = parseInt(getArg('delay', '5000'));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let isShuttingDown = false;

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, finishing current book then stopping...');
  isShuttingDown = true;
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, finishing current book then stopping...');
  isShuttingDown = true;
});

async function main() {
  console.log('='.repeat(60));
  console.log('PG Batch - Loop Processing');
  console.log(`  Max books: ${MAX_BOOKS} | Delay: ${DELAY_MS}ms`);
  console.log('='.repeat(60));

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < MAX_BOOKS && !isShuttingDown; i++) {
    console.log(`\n--- Book ${i + 1}/${MAX_BOOKS} ---`);

    try {
      // Pull next queued job
      const jobs = await workerClient.pullNextJob('queued', 1);

      if (!jobs || (Array.isArray(jobs) && jobs.length === 0)) {
        console.log('No more queued jobs. Stopping.');
        break;
      }

      const job: JobData = Array.isArray(jobs) ? jobs[0] : jobs;
      console.log(`Job ${job.id}: Gutenberg ID ${job.gutenbergId} (priority: ${job.priority})`);

      const result = await processBook(job.gutenbergId, job.id, job.attempts || 0);
      processed++;

      console.log(`  -> OK: "${result.title}" (${result.chapterCount} chapters, quality: ${result.qualityScore})`);
    } catch (err) {
      failed++;
      console.error(`  -> FAILED: ${err instanceof Error ? err.message : err}`);
    }

    // Delay between books (unless shutting down or last iteration)
    if (i < MAX_BOOKS - 1 && !isShuttingDown) {
      console.log(`  Waiting ${DELAY_MS}ms...`);
      await sleep(DELAY_MS);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Batch Complete');
  console.log(`  Processed: ${processed}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Total:     ${processed + failed}`);
  if (isShuttingDown) {
    console.log('  (Stopped early due to shutdown signal)');
  }
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Batch failed:', err);
  process.exit(1);
});
