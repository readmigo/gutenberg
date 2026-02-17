import 'dotenv/config';
import { workerClient } from './lib/worker-client';

// Parse CLI args
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');

interface StatsResponse {
  total_books: number;
  by_status: Record<string, number>;
  total_chapters: number;
  total_words: number;
  avg_quality_score: number;
  total_jobs: number;
  jobs_by_status: Record<string, number>;
}

async function main() {
  console.log('='.repeat(60));
  console.log('Gutenberg Quality Report');
  console.log('='.repeat(60));

  // Fetch aggregate stats from Worker API
  let stats: StatsResponse;
  try {
    const { data } = await (workerClient as any).http.get('/internal/stats');
    stats = data;
  } catch (err) {
    console.error('Failed to fetch stats:', err instanceof Error ? err.message : err);
    console.error('Make sure WORKER_BASE_URL and WORKER_INTERNAL_KEY are set.');
    process.exit(1);
  }

  // Books summary
  console.log('\n  BOOKS');
  console.log('  ' + '-'.repeat(40));
  console.log(`  Total:             ${stats.total_books || 0}`);

  if (stats.by_status) {
    for (const [status, count] of Object.entries(stats.by_status)) {
      console.log(`    ${status.padEnd(18)} ${count}`);
    }
  }

  console.log(`  Total chapters:    ${stats.total_chapters || 0}`);
  console.log(`  Total words:       ${(stats.total_words || 0).toLocaleString()}`);
  console.log(`  Avg quality score: ${stats.avg_quality_score?.toFixed(1) || 'N/A'}`);

  // Jobs summary
  console.log('\n  JOBS');
  console.log('  ' + '-'.repeat(40));
  console.log(`  Total:             ${stats.total_jobs || 0}`);

  if (stats.jobs_by_status) {
    for (const [status, count] of Object.entries(stats.jobs_by_status)) {
      console.log(`    ${status.padEnd(18)} ${count}`);
    }
  }

  // Verbose: list failed books
  if (VERBOSE) {
    console.log('\n  FAILED BOOKS');
    console.log('  ' + '-'.repeat(40));

    try {
      const { data } = await (workerClient as any).http.get('/internal/books', {
        params: { status: 'failed', limit: 20 },
      });
      const failedBooks = Array.isArray(data) ? data : data.books || [];

      if (failedBooks.length === 0) {
        console.log('  (none)');
      } else {
        for (const book of failedBooks) {
          console.log(`  #${book.gutenberg_id} ${book.title || 'Unknown'}`);
          if (book.quality_issues) {
            const issues = Array.isArray(book.quality_issues) ? book.quality_issues : [book.quality_issues];
            for (const issue of issues) {
              console.log(`    - ${issue}`);
            }
          }
        }
      }

      // List failed jobs
      console.log('\n  FAILED JOBS');
      console.log('  ' + '-'.repeat(40));
      const { data: jobData } = await (workerClient as any).http.get('/internal/jobs', {
        params: { status: 'failed', limit: 20 },
      });
      const failedJobs = Array.isArray(jobData) ? jobData : jobData.jobs || [];

      if (failedJobs.length === 0) {
        console.log('  (none)');
      } else {
        for (const job of failedJobs) {
          console.log(`  #${job.gutenberg_id} attempts=${job.attempts} error="${job.error_message || 'unknown'}"`);
        }
      }
    } catch (err) {
      console.error('  Failed to fetch details:', err instanceof Error ? err.message : err);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Report generated at ${new Date().toISOString()}`);
  if (!VERBOSE) {
    console.log('Tip: use --verbose for detailed failure info');
  }
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Report failed:', err);
  process.exit(1);
});
