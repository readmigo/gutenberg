import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

/**
 * One-off script: match cover images by filename (Title — Author.png) to
 * books in the DB, upload to R2 with timestamped keys, and update coverUrl.
 *
 * Usage:
 *   npx tsx scripts/pg-cover-match.ts --dir=/path/to/covers --dry-run
 *   npx tsx scripts/pg-cover-match.ts --dir=/path/to/covers
 */

const BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:8787';
const INTERNAL_KEY = process.env.WORKER_INTERNAL_KEY || '';
const PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};
const COVER_DIR = getArg('dir', '');
const DRY_RUN = args.includes('--dry-run');
const OVERRIDES_FILE = getArg('overrides', '');

if (!COVER_DIR) {
  console.error('Usage: --dir=<path> [--dry-run]');
  process.exit(1);
}

const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'X-Internal-Key': INTERNAL_KEY, 'Content-Type': 'application/json' },
  timeout: 60000,
});

interface Book {
  id: string;
  gutenbergId: number;
  title: string;
  author: string;
  coverUrl: string | null;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[;:,.'"!?—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  const stop = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'to', 'for']);
  return new Set(
    normalize(s)
      .split(' ')
      .filter((w) => w.length > 1 && !stop.has(w))
  );
}

function scoreMatch(fileTitle: string, bookTitle: string): number {
  const fileTokens = tokens(fileTitle);
  const bookTokens = tokens(bookTitle);
  if (fileTokens.size === 0 || bookTokens.size === 0) return 0;

  let overlap = 0;
  for (const t of fileTokens) if (bookTokens.has(t)) overlap++;

  // Jaccard similarity
  const union = new Set([...fileTokens, ...bookTokens]);
  return overlap / union.size;
}

async function fetchAllBooks(): Promise<Book[]> {
  const all: Book[] = [];
  const PAGE = 200;
  for (const status of ['ready', 'approved', 'pending']) {
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

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Dir: ${COVER_DIR}\n`);

  if (!fs.existsSync(COVER_DIR)) {
    console.error(`Directory not found: ${COVER_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(COVER_DIR).filter((f) =>
    /\.(png|jpg|jpeg|webp)$/i.test(f)
  );
  console.log(`Found ${files.length} image file(s)`);

  const books = await fetchAllBooks();
  console.log(`Loaded ${books.length} book(s) from DB\n`);

  // Load filename → gutenbergId overrides
  let overrides: Record<string, number> = {};
  if (OVERRIDES_FILE && fs.existsSync(OVERRIDES_FILE)) {
    overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    console.log(`Loaded ${Object.keys(overrides).length} override(s)\n`);
  }
  const bookById = new Map(books.map((b) => [b.gutenbergId, b]));

  interface Match {
    file: string;
    fileTitle: string;
    book: Book | null;
    score: number;
    runnerUp?: { book: Book; score: number };
  }

  const matches: Match[] = [];

  for (const file of files) {
    const nameNoExt = file.replace(/\.[^.]+$/, '');
    // Split on "—" or "-" to get title
    const parts = nameNoExt.split(/\s*—\s*|\s+-\s+/);
    const fileTitle = parts[0].trim();

    // Check overrides first
    if (overrides[file] && bookById.has(overrides[file])) {
      matches.push({
        file,
        fileTitle,
        book: bookById.get(overrides[file])!,
        score: 1.0,
      });
      continue;
    }

    let best: { book: Book; score: number } | null = null;
    let runnerUp: { book: Book; score: number } | null = null;

    for (const b of books) {
      const s = scoreMatch(fileTitle, b.title);
      if (!best || s > best.score) {
        runnerUp = best;
        best = { book: b, score: s };
      } else if (!runnerUp || s > runnerUp.score) {
        runnerUp = { book: b, score: s };
      }
    }

    matches.push({
      file,
      fileTitle,
      book: best && best.score >= 0.4 ? best.book : null,
      score: best?.score || 0,
      runnerUp: runnerUp || undefined,
    });
  }

  // Print match report
  console.log('Match report:');
  console.log('='.repeat(80));
  const matched = matches.filter((m) => m.book);
  const unmatched = matches.filter((m) => !m.book);

  for (const m of matched) {
    console.log(`  ✓ ${m.file}`);
    console.log(`      → PG#${m.book!.gutenbergId} "${m.book!.title}" (score: ${m.score.toFixed(2)})`);
  }

  if (unmatched.length > 0) {
    console.log('\nUnmatched:');
    for (const m of unmatched) {
      console.log(`  ✗ ${m.file} (best score: ${m.score.toFixed(2)})`);
      if (m.runnerUp) {
        console.log(`      best guess: "${m.runnerUp.book.title}"`);
      }
    }
  }

  console.log(`\n${matched.length}/${files.length} matched.`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] — no uploads performed.');
    return;
  }

  if (matched.length === 0) {
    console.log('Nothing to upload.');
    return;
  }

  console.log('\nUploading...');
  let ok = 0;
  let fail = 0;

  for (const m of matched) {
    const book = m.book!;
    try {
      const filePath = path.join(COVER_DIR, m.file);
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(m.file).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

      // Upload with timestamped key
      const ts = Date.now();
      const outExt = ext === '.png' ? 'png' : ext === '.webp' ? 'webp' : 'jpg';
      const newKey = `books/${book.gutenbergId}/cover-${ts}.${outExt}`;

      await axios.put(`${BASE_URL}/internal/r2/${newKey}`, buffer, {
        headers: { 'X-Internal-Key': INTERNAL_KEY, 'Content-Type': mimeType },
        timeout: 60000,
        maxBodyLength: 50 * 1024 * 1024,
      });

      await api.put(`/internal/books/${book.id}`, {
        gutenbergId: book.gutenbergId,
        coverUrl: newKey,
        coverSource: 'manual',
      });

      console.log(`  ✓ PG#${book.gutenbergId} ${book.title} → ${newKey}`);
      ok++;
    } catch (err: any) {
      console.error(`  ✗ PG#${book.gutenbergId} ${book.title}: ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone. OK: ${ok}, Failed: ${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
