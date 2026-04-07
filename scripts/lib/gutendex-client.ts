import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';

const BASE_URL = process.env.GUTENDEX_BASE_URL || 'https://gutendex.com';

// File-based cache for Gutendex metadata. Calls to fetchBookById are
// idempotent — the same PG ID returns the same JSON every time — so caching
// them on disk eliminates redundant network requests across runs and is the
// only practical way to survive the rate limit when discovery walks
// hundreds of curated IDs in a single Phase 1 sweep.
const CACHE_DIR = path.join(os.tmpdir(), 'readmigo-gutenberg-meta-cache');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePathFor(id: number): string {
  return path.join(CACHE_DIR, `${id}.json`);
}

function readCachedBook(id: number): GutendexBook | null {
  const file = cachePathFor(id);
  if (!fs.existsSync(file)) return null;
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null) return null; // sentinel for cached 404
    return parsed as GutendexBook;
  } catch {
    return null;
  }
}

function writeCachedBook(id: number, data: GutendexBook | null): void {
  ensureCacheDir();
  try {
    fs.writeFileSync(cachePathFor(id), JSON.stringify(data));
  } catch {
    // Cache write failures are non-fatal — we'll just refetch next time.
  }
}

export interface GutendexBook {
  id: number;
  title: string;
  authors: Array<{ name: string; birth_year: number | null; death_year: number | null }>;
  subjects: string[];
  bookshelves: string[];
  languages: string[];
  formats: Record<string, string>;
  download_count: number;
  media_type: string;
}

interface GutendexResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: GutendexBook[];
}

/**
 * Walk Gutendex pagination with retry on transient failures including 429.
 * The droplet's IP gets aggressively rate-limited so a single 429 should not
 * abort Phase 2 of pg-discover.
 */
export async function fetchPage(page: number, languages = 'en'): Promise<GutendexResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const { data } = await axios.get<GutendexResponse>(`${BASE_URL}/books/`, {
        params: { languages, mime_type: 'application/epub+zip', page },
        timeout: 60_000,
        maxRedirects: 5,
      });
      return data;
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      // 404 on a page means we walked past the end of pagination.
      if (status === 404) {
        return { count: 0, next: null, previous: null, results: [] };
      }
      if (attempt < 5) {
        const wait = status === 429 ? 30_000 : 5_000;
        await new Promise((r) => setTimeout(r, wait * attempt));
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Gutendex fetchPage failed for page ${page}: ${msg}`);
}

export function getEpubUrl(book: GutendexBook): string | null {
  return book.formats['application/epub+zip'] || book.formats['application/epub'] || null;
}

/**
 * Fetch metadata for a single PG book. Uses an on-disk cache so repeated
 * lookups (across multiple discovery runs, or within a single run when the
 * curated and Gutendex-walk paths overlap) hit the network at most once
 * per 7 days per id. 404 responses are also cached as null sentinels so
 * removed books don't keep retrying.
 */
export async function fetchBookById(id: number): Promise<GutendexBook | null> {
  const cached = readCachedBook(id);
  if (cached) return cached;

  // Check the file directly for the null sentinel — readCachedBook returns
  // null both for "no cache" and "cached 404", but only the latter should
  // short-circuit the network call.
  const file = cachePathFor(id);
  if (fs.existsSync(file)) {
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs <= CACHE_TTL_MS) {
        const raw = fs.readFileSync(file, 'utf8');
        if (raw.trim() === 'null') return null;
      }
    } catch {
      // fall through to network
    }
  }

  // Gutendex added a 301 redirect to the trailing-slash form; use it directly
  // to avoid an extra round-trip on every call.
  const url = `${BASE_URL}/books/${id}/`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const { data } = await axios.get<GutendexBook>(url, {
        timeout: 30_000,
        maxRedirects: 5,
      });
      writeCachedBook(id, data);
      return data;
    } catch (err: any) {
      // Genuine "not found" — book removed upstream. Cache the null sentinel
      // so subsequent runs don't retry it.
      if (err?.response?.status === 404) {
        writeCachedBook(id, null);
        return null;
      }
      // Anything else (timeouts, 5xx, 429, DNS, socket hang-up) is transient.
      // Back off and retry; only give up after the last attempt.
      lastErr = err;
      if (attempt < 5) {
        const status = err?.response?.status;
        const wait = status === 429 ? 30_000 : 2_000;
        await new Promise((r) => setTimeout(r, wait * attempt));
      }
    }
  }
  // Throw the last error so upstream can distinguish this from a clean 404.
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Gutendex fetch failed for id=${id}: ${msg}`);
}
