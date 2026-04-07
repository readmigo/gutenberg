/**
 * Pre-download SE and PG EPUBs into the calibration cache directory so that
 * subsequent rounds of run-round.ts can run against the cached files without
 * hammering standardebooks.org (which rate-limits at HTTP 429 after only a
 * handful of burst downloads).
 *
 * Strategy:
 *   - Pick N single-source SE entries from se-pg-index.json that are NOT
 *     already in se-r2-index.json and NOT already tested in results.json.
 *   - For each, download the PG EPUB from the pglaf mirror (no rate limit)
 *     in parallel with the SE EPUB from standardebooks.org (rate-limited,
 *     so we sleep between SE requests).
 *   - Files land in the same CACHE_DIR that run-round.ts reads from, with
 *     the same URL-derived keys so cache hits line up naturally.
 *   - On SE-side 429 responses we back off and retry up to 5 times.
 *
 * Usage:
 *   npx ts-node calibrate/prefetch-cache.ts --count 400
 *   npx ts-node calibrate/prefetch-cache.ts --count 400 --delay 12000
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';

interface IndexEntry {
  seSlug: string;
  seRepo: string;
  pgIds: number[];
}

interface R2IndexEntry {
  seSlug: string;
}

interface ResultsFile {
  rounds: Array<{ rows: Array<{ pgId: number }> }>;
}

const CAL_DIR = path.resolve(__dirname);
const INDEX_FILE = path.join(CAL_DIR, 'se-pg-index.json');
const R2_INDEX_FILE = path.join(CAL_DIR, 'se-r2-index.json');
const RESULTS_FILE = path.join(CAL_DIR, 'results.json');
const CACHE_DIR = path.join(os.tmpdir(), 'readmigo-gutenberg-calibrate-cache');

const http = axios.create({
  timeout: 120_000,
  maxRedirects: 5,
  headers: { 'User-Agent': 'Mozilla/5.0 (readmigo-gutenberg-calibration/1)' },
});

function parseArgs(): { count: number; delay: number } {
  const args = process.argv.slice(2);
  let count = 400;
  let delay = 12_000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && i + 1 < args.length) {
      count = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--delay' && i + 1 < args.length) {
      delay = Number(args[i + 1]);
      i++;
    }
  }
  return { count, delay };
}

function pgEpubUrl(pgId: number): string {
  return `https://aleph.pglaf.org/cache/epub/${pgId}/pg${pgId}-images.epub`;
}

function seEpubUrl(repo: string, seSlug: string): string {
  const filename = repo.toLowerCase();
  return `https://standardebooks.org/ebooks/${seSlug}/downloads/${filename}.epub?source=download`;
}

function cachePathFor(url: string, prefix: string): string {
  const key = url.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(CACHE_DIR, `${prefix}-${key}.epub`);
}

function isCachedEpub(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const buf = fs.readFileSync(file);
  if (buf.length < 4) return false;
  return buf[0] === 0x50 && buf[1] === 0x4b;
}

async function downloadOnce(url: string, target: string): Promise<boolean> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
      const buf = Buffer.from(res.data);
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        throw new Error(`not a ZIP (${buf.length} bytes)`);
      }
      fs.writeFileSync(target, buf);
      return true;
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      if (status === 404) {
        console.log(`    404 ${url}`);
        return false;
      }
      if (attempt < 5) {
        // 429 or transient: longer backoff.
        const wait = status === 429 ? 20_000 : 3_000;
        await new Promise((r) => setTimeout(r, wait * attempt));
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.log(`    FAIL ${url} -> ${msg}`);
  return false;
}

async function main() {
  const { count, delay } = parseArgs();

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const pgIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).entries as IndexEntry[];
  // Normalize R2 sourceId separators (some use `_`, some use `/`) to match
  // the slash-style keys used throughout se-pg-index.json.
  const r2Set = new Set<string>(
    (JSON.parse(fs.readFileSync(R2_INDEX_FILE, 'utf8')).entries as R2IndexEntry[]).map(
      (e) => e.seSlug.replace(/_/g, '/'),
    ),
  );
  const results: ResultsFile = fs.existsSync(RESULTS_FILE)
    ? JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'))
    : { rounds: [] };
  const tested = new Set<number>();
  for (const round of results.rounds) for (const row of round.rows) tested.add(row.pgId);

  // Candidates: single-source PG, NOT already in R2 (R2 ones are already
  // usable via run-round), NOT already tested. Sorted deterministically.
  const candidates = pgIndex
    .filter((e) => e.pgIds.length === 1)
    .filter((e) => !r2Set.has(e.seSlug))
    .filter((e) => !tested.has(e.pgIds[0]))
    .sort((a, b) => a.seSlug.localeCompare(b.seSlug));

  console.log(`Candidate pool: ${candidates.length} books`);
  console.log(`Target: ${count}, delay between SE requests: ${delay}ms\n`);

  const toFetch = candidates.slice(0, count);

  let pgOk = 0;
  let seOk = 0;
  let skipped = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const entry = toFetch[i];
    const pgId = entry.pgIds[0];
    const pgUrl = pgEpubUrl(pgId);
    const seUrl = seEpubUrl(entry.seRepo, entry.seSlug);
    const pgTarget = cachePathFor(pgUrl, `pg-${pgId}`);
    const seTarget = cachePathFor(seUrl, `se-${pgId}`);

    const pgHave = isCachedEpub(pgTarget);
    const seHave = isCachedEpub(seTarget);

    if (pgHave && seHave) {
      skipped++;
      if ((i + 1) % 25 === 0 || i === toFetch.length - 1) {
        console.log(
          `[${i + 1}/${toFetch.length}] cached: ${entry.seSlug} (skipped=${skipped} pg=${pgOk} se=${seOk})`,
        );
      }
      continue;
    }

    // PG and SE downloads run in parallel for wall-clock efficiency; the
    // inter-book delay after this call slows the SE host specifically.
    const [pgResult, seResult] = await Promise.all([
      pgHave ? Promise.resolve(true) : downloadOnce(pgUrl, pgTarget),
      seHave ? Promise.resolve(true) : downloadOnce(seUrl, seTarget),
    ]);
    if (pgResult) pgOk++;
    if (seResult) seOk++;

    console.log(
      `[${i + 1}/${toFetch.length}] ${entry.seSlug} pg=${pgResult ? 'ok' : 'fail'} se=${seResult ? 'ok' : 'fail'}`,
    );

    if (i < toFetch.length - 1) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.log('\nPrefetch summary:');
  console.log(`  requested: ${toFetch.length}`);
  console.log(`  already cached: ${skipped}`);
  console.log(`  PG downloaded: ${pgOk}`);
  console.log(`  SE downloaded: ${seOk}`);
}

main().catch((err) => {
  console.error('FAIL:', err?.message || err);
  process.exit(1);
});
