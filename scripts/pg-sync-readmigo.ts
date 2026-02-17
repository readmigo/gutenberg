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
const LIMIT = parseInt(getArg('limit', '10'));

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
  gutenberg_id: number;
  title: string;
  author: string;
  language: string;
  subjects: string[];
  description: string | null;
  cover_url: string | null;
  epub_url: string | null;
  source_url: string;
  chapter_count: number;
  word_count: number;
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

  // Fetch approved books that haven't been synced yet
  // Uses internal endpoint that returns books with status='ready' and synced_at IS NULL
  console.log('\nFetching approved, unsynced books...');

  let books: SyncableBook[];
  try {
    const { data } = await (workerClient as any).http.get('/internal/books', {
      params: { status: 'ready', unsynced: 'true', limit: LIMIT },
    });
    books = Array.isArray(data) ? data : data.books || [];
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
    console.log(`Syncing: ${book.title} (Gutenberg #${book.gutenberg_id})`);

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

      // POST to Readmigo Gutenberg import endpoint
      const { data: importResult } = await readmigoApi.post('/books/gutenberg-import', {
        title: book.title,
        author: book.author,
        gutenbergId: book.gutenberg_id,
        language: book.language,
        subjects: book.subjects,
        wordCount: book.word_count,
        chapterCount: book.chapter_count,
        coverUrl: book.cover_url,
        epubUrl: book.epub_url,
        chapters: chapters.map((ch: any) => ({
          order: ch.order_num,
          title: ch.title,
          contentUrl: ch.content_url,
          wordCount: ch.word_count,
        })),
      });

      const readmigoBookId = importResult.id || importResult.bookId;
      console.log(`  -> Synced! Readmigo book ID: ${readmigoBookId}`);

      // Update book in D1 with sync info
      await workerClient.updateBook(book.id, {
        readmigo_book_id: readmigoBookId,
        synced_at: new Date().toISOString(),
      });

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
