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

const readmigoApi = axios.create({
  baseURL: READMIGO_API_URL,
  headers: {
    'Content-Type': 'application/json',
    ...(READMIGO_API_KEY ? { 'X-API-Key': READMIGO_API_KEY } : {}),
  },
  timeout: 30000,
});

interface ZhBook {
  id: string;
  title: string;
  author: string;
  language: string | null;
  sourceType: string | null;
  coverUrl: string | null;
  wordCount: number;
  chapterCount: number;
  status: string | null;
  needsCorrection: number | null;
  zhSourceId: number | null;
  readmigoBookId: string | null;
  syncedAt: string | null;
}

function mapSourceType(sourceType: string | null): string {
  if (sourceType === 'haodoo') return 'HAODOO';
  if (sourceType === 'wenshuoge') return 'WENSHUOGE';
  return 'USER_UPLOAD';
}

async function main() {
  console.log('='.repeat(60));
  console.log('ZH Sync Readmigo');
  console.log(`  API: ${READMIGO_API_URL}`);
  console.log(`  Limit: ${LIMIT} | Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  if (!READMIGO_API_KEY && !DRY_RUN) {
    console.error('Error: READMIGO_API_KEY is required for non-dry-run mode.');
    process.exit(1);
  }

  // Fetch ready books from zh endpoint
  console.log('\nFetching ready Chinese books...');

  let books: ZhBook[] = [];
  try {
    const PAGE = 200;
    let offset = 0;
    while (true) {
      const { data } = await (workerClient as any).http.get('/api/zh/books', {
        params: { status: 'ready', limit: PAGE, offset },
      });
      const rows = Array.isArray(data) ? data : data.books || [];
      books.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }

    // Filter out books that need correction
    books = books.filter((b) => !b.needsCorrection || b.needsCorrection === 0);

    // Filter out already synced books
    books = books.filter((b) => !b.readmigoBookId && !b.syncedAt);

    // Apply LIMIT
    books = books.slice(0, LIMIT);
  } catch (err) {
    console.error('Failed to fetch books:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (books.length === 0) {
    console.log('No books to sync. All ready Chinese books are already synced or need correction.');
    return;
  }

  console.log(`Found ${books.length} book(s) to sync.\n`);

  let synced = 0;
  let failed = 0;

  const contentBase = process.env.R2_PUBLIC_URL || (process.env.WORKER_BASE_URL || 'https://gutenberg-api.logan676395.workers.dev') + '/content';

  for (const book of books) {
    console.log(`Syncing: ${book.title} (${book.author}) [${book.sourceType}]`);

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

      // Build absolute public cover URL
      const coverUrl = book.coverUrl
        ? (book.coverUrl.startsWith('http') ? book.coverUrl : `${contentBase}/${book.coverUrl}`)
        : null;

      // POST to Readmigo Gutenberg import endpoint
      const { data: importResult } = await readmigoApi.post('/books/gutenberg-import', {
        title: book.title,
        author: book.author,
        gutenbergId: null,
        language: book.language || 'zh',
        subjects: [],
        wordCount: book.wordCount,
        chapterCount: book.chapterCount,
        coverUrl,
        visibility: 'WEB_ONLY',
        source: mapSourceType(book.sourceType),
        chapters: chapters.map((ch: any) => {
          const rawUrl = ch.contentUrl ?? ch.content_url;
          const absUrl = rawUrl && !rawUrl.startsWith('http') ? `${contentBase}/${rawUrl}` : rawUrl;
          return {
            order: ch.orderNum ?? ch.order_num,
            title: (ch.title || '').slice(0, 255),
            contentUrl: absUrl,
            wordCount: ch.wordCount ?? ch.word_count,
          };
        }),
      });

      const readmigoBookId = importResult.id || importResult.bookId;
      console.log(`  -> Synced! Readmigo book ID: ${readmigoBookId}`);

      // Update book in D1 with sync info
      await workerClient.updateBook(book.id, {
        readmigoBookId: readmigoBookId,
        syncedAt: new Date().toISOString(),
        status: 'synced',
      });

      // Update zh_source status if we have one
      if (book.zhSourceId) {
        await (workerClient as any).http.put(`/api/zh/sources/${book.zhSourceId}`, {
          status: 'synced',
        });
      }

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
