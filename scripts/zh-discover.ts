import 'dotenv/config';
import { workerClient } from './lib/worker-client';
import * as haodoo from './lib/haodoo-client';
import * as wenshuoge from './lib/wenshuoge-client';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const SOURCE = getArg('source', 'all') as 'haodoo' | 'wenshuoge' | 'all';
const LIMIT = parseInt(getArg('limit', '500'));
const DRY_RUN = args.includes('--dry-run');

async function main() {
  console.log('='.repeat(60));
  console.log('ZH Discover - Chinese Book Discovery');
  console.log(`  Source: ${SOURCE} | Limit: ${LIMIT} | Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  let discovered = 0;
  let skipped = 0;
  let failed = 0;

  // Collect books from selected sources
  const haodooBooks: haodoo.HaodooBook[] = [];
  const wenshuogeBooks: wenshuoge.WenshuogeBook[] = [];

  if (SOURCE === 'haodoo' || SOURCE === 'all') {
    console.log('\n[haodoo] Starting discovery...');
    const books = await haodoo.discoverAll(SOURCE === 'haodoo' ? LIMIT : undefined);
    haodooBooks.push(...books);
    console.log(`[haodoo] Discovered ${haodooBooks.length} books`);
  }

  if (SOURCE === 'wenshuoge' || SOURCE === 'all') {
    console.log('\n[wenshuoge] Starting discovery...');
    const remaining = SOURCE === 'all' ? Math.max(0, LIMIT - haodooBooks.length) : LIMIT;
    const books = await wenshuoge.discoverAll(SOURCE === 'wenshuoge' ? LIMIT : remaining || undefined);
    wenshuogeBooks.push(...books);
    console.log(`[wenshuoge] Discovered ${wenshuogeBooks.length} books`);
  }

  // Process haodoo books
  if (haodooBooks.length > 0) {
    console.log(`\n[haodoo] Submitting ${haodooBooks.length} books to Worker API...`);
    for (const book of haodooBooks) {
      if (discovered + skipped + failed >= LIMIT) break;

      if (DRY_RUN) {
        console.log(`  [DRY RUN] haodoo: ${book.title} by ${book.author || '(unknown)'} [${book.sourceBookId}]`);
        discovered++;
        continue;
      }

      try {
        await (workerClient as any).http.post('/api/zh/sources', {
          sourceType: 'haodoo',
          sourceBookId: book.sourceBookId,
          title: book.title,
          author: book.author,
          downloadUrl: book.downloadUrl,
          sourceUrl: book.sourceUrl,
          epubFormat: book.format === 'epub' ? 'epub' : 'txt',
        });
        console.log(`  [ok] haodoo: ${book.title} [${book.sourceBookId}]`);
        discovered++;
      } catch (err: any) {
        if (err?.response?.status === 409) {
          console.log(`  [skip] haodoo: ${book.title} [${book.sourceBookId}] — already exists`);
          skipped++;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  [fail] haodoo: ${book.title} [${book.sourceBookId}] — ${msg}`);
          failed++;
        }
      }
    }
  }

  // Process wenshuoge books
  if (wenshuogeBooks.length > 0) {
    console.log(`\n[wenshuoge] Submitting ${wenshuogeBooks.length} books to Worker API...`);
    for (const book of wenshuogeBooks) {
      if (discovered + skipped + failed >= LIMIT) break;

      if (DRY_RUN) {
        console.log(`  [DRY RUN] wenshuoge: ${book.title} by ${book.author || '(unknown)'} [${book.sourceBookId}]`);
        discovered++;
        continue;
      }

      try {
        await (workerClient as any).http.post('/api/zh/sources', {
          sourceType: 'wenshuoge',
          sourceBookId: book.sourceBookId,
          title: book.title,
          author: book.author,
          downloadUrl: book.downloadUrl,
          sourceUrl: book.sourceUrl,
          epubFormat: book.format,
        });
        console.log(`  [ok] wenshuoge: ${book.title} [${book.sourceBookId}]`);
        discovered++;
      } catch (err: any) {
        if (err?.response?.status === 409) {
          console.log(`  [skip] wenshuoge: ${book.title} [${book.sourceBookId}] — already exists`);
          skipped++;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  [fail] wenshuoge: ${book.title} [${book.sourceBookId}] — ${msg}`);
          failed++;
        }
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Summary: ${discovered} discovered, ${skipped} skipped (already exist), ${failed} failed`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('ZH Discover failed:', err);
  process.exit(1);
});
