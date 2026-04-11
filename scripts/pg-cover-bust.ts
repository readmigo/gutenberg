import 'dotenv/config';
import axios from 'axios';

/**
 * One-time script: re-upload existing covers with timestamped R2 keys
 * so CDN/browser caches serve the latest version.
 *
 * Usage:
 *   npx tsx scripts/pg-cover-bust.ts --dry-run   # preview only
 *   npx tsx scripts/pg-cover-bust.ts              # execute
 */

const BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:8787';
const INTERNAL_KEY = process.env.WORKER_INTERNAL_KEY || '';
const DRY_RUN = process.argv.includes('--dry-run');

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'X-Internal-Key': INTERNAL_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

interface Book {
  id: string;
  gutenbergId: number;
  title: string;
  coverUrl: string | null;
}

async function fetchAllBooks(): Promise<Book[]> {
  const all: Book[] = [];
  const PAGE = 200;
  for (const status of ['ready', 'approved']) {
    let offset = 0;
    while (true) {
      const { data } = await api.get('/internal/books', {
        params: { status, limit: PAGE, offset },
      });
      const books = Array.isArray(data) ? data : [];
      all.push(...books);
      if (books.length < PAGE) break;
      offset += PAGE;
    }
  }
  return all;
}

async function run() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}\n`);

  const books = await fetchAllBooks();
  const withCover = books.filter((b) => b.coverUrl);
  // Skip books already using timestamped keys (cover-<digits>.)
  const needsBust = withCover.filter((b) => !b.coverUrl!.match(/cover-\d+\./));

  console.log(`Total books: ${books.length}`);
  console.log(`With cover: ${withCover.length}`);
  console.log(`Already busted: ${withCover.length - needsBust.length}`);
  console.log(`Need bust: ${needsBust.length}\n`);

  if (DRY_RUN) {
    for (const b of needsBust) {
      console.log(`  [dry] ${b.gutenbergId} - ${b.title} → ${b.coverUrl}`);
    }
    return;
  }

  let ok = 0;
  let fail = 0;

  for (const book of needsBust) {
    try {
      // Download existing cover via content endpoint
      const coverResp = await axios.get(`${BASE_URL}/content/${book.coverUrl}`, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      const buffer = Buffer.from(coverResp.data);
      const contentType = coverResp.headers['content-type'] || 'image/jpeg';

      // Build new key with timestamp
      const oldKey = book.coverUrl!;
      const ext = oldKey.match(/\.(png|jpg|jpeg)$/i)?.[1] || 'jpg';
      const ts = Date.now();
      const dir = oldKey.substring(0, oldKey.lastIndexOf('/'));
      const newKey = `${dir}/cover-${ts}.${ext}`;

      // Upload with new key
      await axios.put(`${BASE_URL}/internal/r2/${newKey}`, buffer, {
        headers: { 'X-Internal-Key': INTERNAL_KEY, 'Content-Type': contentType },
        timeout: 30000,
        maxBodyLength: 50 * 1024 * 1024,
      });

      // Update database
      await api.put(`/internal/books/${book.id}`, {
        gutenbergId: book.gutenbergId,
        coverUrl: newKey,
      });

      ok++;
      console.log(`  ✓ ${book.gutenbergId} ${book.title}  ${oldKey} → ${newKey}`);
    } catch (err: any) {
      fail++;
      console.error(`  ✗ ${book.gutenbergId} ${book.title}: ${err.message}`);
    }
  }

  console.log(`\nDone. OK: ${ok}, Failed: ${fail}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
