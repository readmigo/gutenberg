import 'dotenv/config';
import axios from 'axios';
import { workerClient } from './lib/worker-client';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const sourceArg = getArg('source', 'all') as 'haodoo' | 'wenshuoge' | 'all';
const limit = parseInt(getArg('limit', '50'), 10);
const retryFailed = args.includes('--retry-failed');

const BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:8787';
const INTERNAL_KEY = process.env.WORKER_INTERNAL_KEY || '';

let isShuttingDown = false;

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  isShuttingDown = true;
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  isShuttingDown = true;
});

function getContentType(ext: string): string {
  if (ext === 'epub') return 'application/epub+zip';
  return 'text/plain';
}

function getExtFromUrl(downloadUrl: string): string {
  const match = downloadUrl.match(/\.([a-z0-9]+)(\?.*)?$/i);
  return match ? match[1].toLowerCase() : 'epub';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ZhSource {
  id: string;
  sourceType: string;
  sourceBookId: string;
  downloadUrl: string;
  status: string;
  title?: string;
}

async function fetchSources(status: string, sourceType: string, limitN: number): Promise<ZhSource[]> {
  const params: Record<string, string | number> = { status, limit: limitN };
  if (sourceType !== 'all') {
    params.source_type = sourceType;
  }
  const response = await (workerClient as any).http.get('/api/zh/sources', { params });
  const data = response.data;
  // Support both { sources: [...] } and plain array
  return Array.isArray(data) ? data : (data.sources ?? []);
}

async function updateSourceStatus(id: string, status: string, error?: string): Promise<void> {
  const body: Record<string, string> = { status };
  if (error) body.error = error;
  await (workerClient as any).http.put(`/api/zh/sources/${id}`, body);
}

async function downloadAndUpload(source: ZhSource): Promise<void> {
  const ext = getExtFromUrl(source.downloadUrl);
  const r2Key = `zh-raw/${source.sourceType}/${source.sourceBookId}.${ext}`;
  const contentType = getContentType(ext);

  // Download EPUB/txt
  const downloadResp = await axios.get(source.downloadUrl, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: 100 * 1024 * 1024,
    headers: {
      'User-Agent': 'Readmigo-Bot/1.0',
    },
  });

  const buffer = Buffer.from(downloadResp.data);

  // Upload to R2 via Worker internal proxy
  await axios.put(`${BASE_URL}/internal/r2/${r2Key}`, buffer, {
    headers: {
      'X-Internal-Key': INTERNAL_KEY,
      'Content-Type': contentType,
    },
    timeout: 120000,
    maxBodyLength: 100 * 1024 * 1024,
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('ZH Download - Chinese EPUB Download Script');
  console.log('='.repeat(60));
  console.log(`  Source:       ${sourceArg}`);
  console.log(`  Limit:        ${limit}`);
  console.log(`  Retry failed: ${retryFailed}`);
  console.log('');

  const status = retryFailed ? 'failed' : 'discovered';

  let sources: ZhSource[];
  try {
    sources = await fetchSources(status, sourceArg, limit);
  } catch (err) {
    console.error('Failed to fetch sources:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (sources.length === 0) {
    console.log(`No sources with status='${status}' found. Nothing to do.`);
    return;
  }

  console.log(`Found ${sources.length} source(s) to download.\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < sources.length; i++) {
    if (isShuttingDown) {
      console.log('Shutdown requested, stopping early.');
      break;
    }

    const source = sources[i];
    const label = `[${i + 1}/${sources.length}] ${source.sourceType}/${source.sourceBookId}`;
    const title = source.title ? ` "${source.title}"` : '';
    console.log(`${label}${title}`);
    console.log(`  URL: ${source.downloadUrl}`);

    try {
      await downloadAndUpload(source);
      await updateSourceStatus(source.id, 'downloaded');
      console.log(`  -> downloaded & uploaded\n`);
      successCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  -> FAILED: ${message}\n`);
      try {
        await updateSourceStatus(source.id, 'failed', message);
      } catch (updateErr) {
        console.error(`  (also failed to update status: ${updateErr instanceof Error ? updateErr.message : updateErr})`);
      }
      failCount++;
    }

    // Polite crawling: 2-second delay between downloads (skip after last)
    if (i < sources.length - 1 && !isShuttingDown) {
      await sleep(2000);
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
