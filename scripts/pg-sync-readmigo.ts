import 'dotenv/config';
import axios from 'axios';
import { workerClient } from './lib/worker-client';

const READMIGO_API_URL = process.env.READMIGO_API_URL || 'https://readmigo-api.fly.dev/api/v1';
const READMIGO_API_KEY = process.env.READMIGO_API_KEY || '';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const DRY_RUN = args.includes('--dry-run');
const LIMIT = parseInt(getArg('limit', '50'));
const COVER_SOURCE = getArg('cover-source', ''); // e.g. 'manual' to only sync polished

const readmigoApi = axios.create({
  baseURL: READMIGO_API_URL,
  headers: {
    'Content-Type': 'application/json',
    ...(READMIGO_API_KEY ? { 'X-API-Key': READMIGO_API_KEY } : {}),
  },
  timeout: 30000,
});

interface SyncableBook {
  id: string;
  gutenbergId: number;
  title: string;
  author: string;
  language: string;
  subjects: string | string[] | null;
  description: string | null;
  coverUrl: string | null;
  epubUrl: string | null;
  sourceUrl: string;
  chapterCount: number;
  wordCount: number;
  fleschScore: number | null;
  cefrLevel: string | null;
  difficultyScore: number | null;
  estimatedReadingMinutes: number | null;
  aiDescription: string | null;
  aiTags: string | null;
  coverSource: string | null;
}

async function main() {
  console.log('='.repeat(60));
  console.log('PG Sync Readmigo');
  console.log(`  API: ${READMIGO_API_URL}`);
  console.log(`  Limit: ${LIMIT} | Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  if (!READMIGO_API_KEY && !DRY_RUN) {
    console.error('Error: READMIGO_API_KEY is required for non-dry-run mode.');
    process.exit(1);
  }

  // Fetch ready + unsynced books (paginated, optionally filtered by coverSource)
  console.log(`\nFetching ready, unsynced books${COVER_SOURCE ? ' (coverSource=' + COVER_SOURCE + ')' : ''}...`);

  let books: SyncableBook[] = [];
  try {
    const PAGE = 200;
    let offset = 0;
    while (true) {
      const { data } = await (workerClient as any).http.get('/internal/books', {
        params: { status: 'ready', unsynced: 'true', limit: PAGE, offset },
      });
      const rows = Array.isArray(data) ? data : data.books || [];
      books.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
      if (books.length >= LIMIT * 10) break; // safety
    }
    // Filter by cover source if requested
    if (COVER_SOURCE) {
      books = books.filter((b) => b.coverSource === COVER_SOURCE);
    }
    // Apply LIMIT after filtering
    books = books.slice(0, LIMIT);
  } catch (err) {
    console.error('Failed to fetch books:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (books.length === 0) {
    console.log('No books to sync. All approved books are already synced.');
    return;
  }

  console.log(`Found ${books.length} book(s) to sync.\n`);

  let synced = 0;
  let failed = 0;

  for (const book of books) {
    console.log(`Syncing: ${book.title} (Gutenberg #${book.gutenbergId})`);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would POST to ${READMIGO_API_URL}/books/gutenberg-import`);
      synced++;
      continue;
    }

    try {
      // Fetch chapters from Worker API
      const { data: chaptersData } = await (workerClient as any).http.get(
        `/internal/books/${book.id}/chapters`,
      );
      const chapters = Array.isArray(chaptersData) ? chaptersData : chaptersData.chapters || [];

      // Subjects may come back as a JSON-encoded string or an array
      let subjectsArr: string[] = [];
      if (Array.isArray(book.subjects)) {
        subjectsArr = book.subjects;
      } else if (typeof book.subjects === 'string' && book.subjects) {
        try { subjectsArr = JSON.parse(book.subjects); } catch { subjectsArr = []; }
      }

      // Build absolute public cover URL (prefer R2_PUBLIC_URL, fallback to worker content endpoint)
      const coverBase = process.env.R2_PUBLIC_URL || 'https://gutenberg-api.logan676395.workers.dev/content';
      const coverUrl = book.coverUrl
        ? (book.coverUrl.startsWith('http') ? book.coverUrl : `${coverBase}/${book.coverUrl}`)
        : null;
      const epubUrl = book.epubUrl
        ? (book.epubUrl.startsWith('http') ? book.epubUrl : `${coverBase}/${book.epubUrl}`)
        : null;

      // POST to Readmigo Gutenberg import endpoint
      const { data: importResult } = await readmigoApi.post('/books/gutenberg-import', {
        title: book.title,
        author: book.author,
        gutenbergId: book.gutenbergId,
        language: book.language,
        subjects: subjectsArr,
        wordCount: book.wordCount,
        chapterCount: book.chapterCount,
        coverUrl,
        epubUrl,
        fleschScore: book.fleschScore,
        cefrLevel: book.cefrLevel,
        difficultyScore: book.difficultyScore,
        estimatedReadingMinutes: book.estimatedReadingMinutes,
        aiDescription: book.aiDescription,
        aiTags: book.aiTags ? JSON.parse(book.aiTags) : [],
        visibility: 'WEB_ONLY',
        chapters: chapters.map((ch: any) => ({
          order: ch.orderNum ?? ch.order_num,
          title: ch.title,
          contentUrl: ch.contentUrl ?? ch.content_url,
          wordCount: ch.wordCount ?? ch.word_count,
        })),
      });

      const readmigoBookId = importResult.id || importResult.bookId;
      console.log(`  -> Synced! Readmigo book ID: ${readmigoBookId}`);

      // Update book in D1 with sync info
      await workerClient.updateBook(book.id, {
        readmigoBookId: readmigoBookId,
        syncedAt: new Date().toISOString(),
      });

      // Record in synced_ids table for discovery dedup
      await workerClient.addSyncedIds([book.gutenbergId]);

      synced++;
    } catch (err) {
      failed++;
      if (axios.isAxiosError(err)) {
        console.error(`  -> FAILED: ${err.response?.status} ${err.response?.data?.message || err.message}`);
      } else {
        console.error(`  -> FAILED: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Sync Complete');
  console.log(`  Synced: ${synced}`);
  console.log(`  Failed: ${failed}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Sync failed:', err);
  process.exit(1);
});
