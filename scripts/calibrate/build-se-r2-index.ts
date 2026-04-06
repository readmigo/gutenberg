/**
 * Build a Standard Ebooks slug -> Readmigo R2 book-id index by paginating
 * through the Readmigo API. Readmigo has already imported ~1380 SE books
 * and stores each EPUB in Cloudflare R2 at
 *   https://cdn.readmigo.app/books/{uuid}/book.epub
 *
 * The Readmigo API exposes each book's sourceId (the SE slug, e.g.
 * "jane-austen/pride-and-prejudice") and the public epubUrl. By walking
 * the paginated /api/v1/books endpoint and pulling detail pages for each
 * entry we can build a lookup table that lets the calibration harness
 * skip standardebooks.org entirely — avoiding its 429 rate limit.
 *
 * Output: scripts/calibrate/se-r2-index.json
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

interface R2Entry {
  seSlug: string;
  readmigoId: string;
  epubUrl: string;
  title: string;
}

const API_BASE = 'https://readmigo-api.fly.dev/api/v1';
const OUT_FILE = path.resolve(__dirname, 'se-r2-index.json');

const http = axios.create({
  timeout: 30_000,
  headers: { 'User-Agent': 'readmigo-gutenberg-calibration/1' },
  maxRedirects: 5,
});

async function fetchBookList(page: number, limit = 50): Promise<{
  items: Array<{ id: string; title: string }>;
  total: number;
}> {
  const { data } = await http.get(`${API_BASE}/books`, { params: { page, limit } });
  return { items: data.items || [], total: data.total || 0 };
}

async function fetchBookDetail(id: string): Promise<{
  id: string;
  title: string;
  source: string;
  sourceId: string | null;
  epubUrl: string | null;
} | null> {
  try {
    const { data } = await http.get(`${API_BASE}/books/${id}`);
    return data;
  } catch (err) {
    return null;
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function pump(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => pump()));
  return results;
}

async function main() {
  console.log('Phase 1: walking /api/v1/books pagination');
  const firstPage = await fetchBookList(1, 50);
  const total = firstPage.total;
  const totalPages = Math.ceil(total / 50);
  console.log(`  total books: ${total}, pages: ${totalPages}`);

  const allIds: Array<{ id: string; title: string }> = [...firstPage.items];
  for (let page = 2; page <= totalPages; page++) {
    const batch = await fetchBookList(page, 50);
    allIds.push(...batch.items);
    if (page % 5 === 0 || page === totalPages) {
      console.log(`  page ${page}/${totalPages}, ${allIds.length} ids so far`);
    }
  }

  console.log(`\nPhase 2: fetching detail for ${allIds.length} books`);
  let fetched = 0;
  const details = await runWithConcurrency(allIds, 10, async (item) => {
    const detail = await fetchBookDetail(item.id);
    fetched++;
    if (fetched % 100 === 0 || fetched === allIds.length) {
      console.log(`  detail: ${fetched}/${allIds.length}`);
    }
    return detail;
  });

  console.log('\nPhase 3: filtering to SE entries with a usable epubUrl');
  const entries: R2Entry[] = [];
  for (const d of details) {
    if (!d) continue;
    if (d.source !== 'STANDARD_EBOOKS') continue;
    if (!d.sourceId || !d.epubUrl) continue;
    entries.push({
      seSlug: d.sourceId,
      readmigoId: d.id,
      epubUrl: d.epubUrl,
      title: d.title,
    });
  }

  entries.sort((a, b) => a.seSlug.localeCompare(b.seSlug));
  console.log(`  ${entries.length} SE entries with R2 epubUrl`);

  const payload = {
    generatedAt: new Date().toISOString(),
    total: entries.length,
    entries,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n');
  console.log(`\nWrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('FAIL:', err?.message || err);
  process.exit(1);
});
