import { drizzle } from 'drizzle-orm/d1';
import { inArray } from 'drizzle-orm';
import { processJobs, books } from '../db/schema';

const GUTENDEX_BASE = 'https://gutendex.com/books';
const DEFAULT_LIMIT = 50;
const MAX_CONSECUTIVE_ALL_EXISTING = 3;

interface GutendexAuthor {
  name: string;
  birth_year: number | null;
  death_year: number | null;
}

interface GutendexBook {
  id: number;
  title: string;
  authors: GutendexAuthor[];
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

export interface DiscoverResult {
  discovered: number;
  skippedExisting: number;
  pagesScanned: number;
}

type DrizzleD1 = ReturnType<typeof drizzle>;

async function fetchGutendexPage(page: number): Promise<GutendexResponse> {
  const url = `${GUTENDEX_BASE}?languages=en&mime_type=${encodeURIComponent('application/epub+zip')}&page=${page}`;
  console.log(`Fetching Gutendex page ${page}: ${url}`);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Readmigo-Gutenberg-Worker/1.0' },
  });

  if (!res.ok) {
    throw new Error(`Gutendex API error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<GutendexResponse>;
}

async function getExistingGutenbergIds(db: DrizzleD1, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();

  const [existingJobs, existingBooks] = await Promise.all([
    db
      .select({ gutenbergId: processJobs.gutenbergId })
      .from(processJobs)
      .where(inArray(processJobs.gutenbergId, ids)),
    db
      .select({ gutenbergId: books.gutenbergId })
      .from(books)
      .where(inArray(books.gutenbergId, ids)),
  ]);

  const existing = new Set<number>();
  for (const row of existingJobs) {
    existing.add(row.gutenbergId);
  }
  for (const row of existingBooks) {
    if (row.gutenbergId !== null) {
      existing.add(row.gutenbergId);
    }
  }
  return existing;
}

export async function discoverNewBooks(
  db: DrizzleD1,
  options?: { limit?: number },
): Promise<DiscoverResult> {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  let discovered = 0;
  let skippedExisting = 0;
  let pagesScanned = 0;
  let consecutiveAllExisting = 0;
  let page = 1;

  console.log(`Starting discovery, limit=${limit}`);

  while (discovered < limit) {
    let data: GutendexResponse;
    try {
      data = await fetchGutendexPage(page);
    } catch (err) {
      console.error(`Failed to fetch page ${page}:`, err);
      break;
    }

    pagesScanned++;

    if (data.results.length === 0) {
      console.log('No more results from Gutendex');
      break;
    }

    const gutenbergIds = data.results.map((b) => b.id);
    const existingIds = await getExistingGutenbergIds(db, gutenbergIds);

    const newBooks = data.results.filter((b) => !existingIds.has(b.id));
    const skipped = data.results.length - newBooks.length;
    skippedExisting += skipped;

    if (newBooks.length === 0) {
      consecutiveAllExisting++;
      console.log(
        `Page ${page}: all ${data.results.length} books already exist (${consecutiveAllExisting}/${MAX_CONSECUTIVE_ALL_EXISTING} consecutive)`,
      );
      if (consecutiveAllExisting >= MAX_CONSECUTIVE_ALL_EXISTING) {
        console.log('Stopping: too many consecutive all-existing pages');
        break;
      }
    } else {
      consecutiveAllExisting = 0;

      // Insert new process_jobs, respecting the remaining limit
      const toInsert = newBooks.slice(0, limit - discovered);

      const values = toInsert.map((b) => ({
        id: crypto.randomUUID(),
        gutenbergId: b.id,
        status: 'queued' as const,
        priority: b.download_count,
      }));

      // D1 has a batch limit, insert in chunks of 20
      const CHUNK_SIZE = 20;
      for (let i = 0; i < values.length; i += CHUNK_SIZE) {
        const chunk = values.slice(i, i + CHUNK_SIZE);
        await db.insert(processJobs).values(chunk);
      }

      discovered += toInsert.length;
      console.log(
        `Page ${page}: discovered ${toInsert.length} new books, skipped ${skipped} existing (total discovered: ${discovered})`,
      );
    }

    // No more pages
    if (!data.next) {
      console.log('No more pages from Gutendex');
      break;
    }

    page++;
  }

  const result: DiscoverResult = { discovered, skippedExisting, pagesScanned };
  console.log('Discovery complete:', result);
  return result;
}
