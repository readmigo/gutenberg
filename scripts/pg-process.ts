import 'dotenv/config';
import { workerClient } from './lib/worker-client';
import { processBook, JobData } from './lib/process-book';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const gutenbergIdArg = args.find(a => a.startsWith('--gutenberg-id='));
const gutenbergId = gutenbergIdArg ? parseInt(gutenbergIdArg.split('=')[1]) : undefined;

let isShuttingDown = false;

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  isShuttingDown = true;
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  isShuttingDown = true;
});

async function main() {
  console.log('='.repeat(60));
  console.log('PG Process - Single Book Pipeline');
  console.log('='.repeat(60));

  let jobId: string | undefined;
  let jobGutenbergId: number;
  let jobAttempts = 0;

  if (gutenbergId) {
    // Direct mode: process a specific Gutenberg ID without a job
    console.log(`\nDirect mode: processing Gutenberg ID ${gutenbergId}`);
    jobGutenbergId = gutenbergId;
  } else {
    // Job mode: pull next queued job from Worker API
    console.log('\nPulling next queued job...');
    const jobs = await workerClient.pullNextJob('queued', 1);

    if (!jobs || (Array.isArray(jobs) && jobs.length === 0)) {
      console.log('No queued jobs available. Nothing to do.');
      return;
    }

    const job: JobData = Array.isArray(jobs) ? jobs[0] : jobs;
    jobId = job.id;
    jobGutenbergId = job.gutenberg_id;
    jobAttempts = job.attempts || 0;

    console.log(`Job ${jobId}: Gutenberg ID ${jobGutenbergId} (priority: ${job.priority}, attempts: ${jobAttempts})`);
  }

  if (isShuttingDown) {
    console.log('Shutdown requested before processing started.');
    return;
  }

  try {
    const result = await processBook(jobGutenbergId, jobId, jobAttempts);

    console.log('\n' + '='.repeat(60));
    console.log('Processing Complete');
    console.log('='.repeat(60));
    console.log(`  Book ID:     ${result.bookId}`);
    console.log(`  Gutenberg:   ${result.gutenbergId}`);
    console.log(`  Title:       ${result.title}`);
    console.log(`  Chapters:    ${result.chapterCount}`);
    console.log(`  Words:       ${result.wordCount.toLocaleString()}`);
    console.log(`  Quality:     ${result.qualityScore}/100 (${result.qualityPass ? 'PASS' : 'FAIL'})`);
  } catch (err) {
    console.error('\nProcessing failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Process failed:', err);
  process.exit(1);
});
