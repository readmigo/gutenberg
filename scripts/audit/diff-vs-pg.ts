/**
 * Content-fidelity audit for ready books.
 *
 * For each sampled book, download our extracted chapter HTML from R2, strip it
 * to normalized text, and compare word-for-word against the Project Gutenberg
 * plain-text edition of the same work. The result is a single extraction-
 * accuracy number per book, which is what Stage 2's "80.7% ready rate" does
 * not tell us on its own.
 *
 * Run:
 *   cd scripts && pnpm tsx audit/diff-vs-pg.ts --sample=20
 *   cd scripts && pnpm tsx audit/diff-vs-pg.ts --ids=1342,113,55
 *
 * Writes a JSON report to scripts/audit/results/diff-<timestamp>.json for
 * later inspection.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const WORKER_BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:8787';
const INTERNAL_KEY = process.env.WORKER_INTERNAL_KEY || '';

// --- arg parsing ---------------------------------------------------

interface Args {
  sample: number;
  ids: number[] | null;
}

function parseArgs(): Args {
  const out: Args = { sample: 20, ids: null };
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--sample=(\d+)$/);
    if (m) out.sample = Number(m[1]);
    const n = a.match(/^--ids=([\d,]+)$/);
    if (n) out.ids = n[1].split(',').map((x) => Number(x));
  }
  return out;
}

// --- text normalization --------------------------------------------

/**
 * Canonicalize text for bag-of-words comparison. Aggressive on purpose:
 * typography, smart quotes, em-dashes and ligature differences between our
 * cleaner's output and PG's raw plain text are not what we're measuring.
 */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ');
}

function wordList(normalized: string): string[] {
  return normalized.split(' ').filter((w) => w.length > 0);
}

// --- PG plain-text ground truth ------------------------------------

const PG_TXT_URLS = (id: number): string[] => [
  `https://aleph.pglaf.org/cache/epub/${id}/pg${id}.txt`,
  `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
  // Some older books use .txt.utf8
  `https://aleph.pglaf.org/cache/epub/${id}/pg${id}.txt.utf8`,
  `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt.utf8`,
];

async function fetchPgPlainText(id: number): Promise<string | null> {
  for (const url of PG_TXT_URLS(id)) {
    try {
      const resp = await axios.get<string>(url, {
        responseType: 'text',
        timeout: 60_000,
        maxRedirects: 5,
        // Tell the server and axios to treat the body as text regardless of
        // the reported mime type — PG sometimes serves text/plain with no
        // charset and axios defaults to JSON parsing.
        transformResponse: (x) => x,
        validateStatus: (s) => s === 200,
      });
      if (typeof resp.data === 'string' && resp.data.length > 500) {
        return resp.data;
      }
    } catch {
      // try next URL
    }
  }
  return null;
}

/**
 * Strip the Project Gutenberg license header and footer. PG's canonical
 * markers are `*** START OF ... ***` / `*** END OF ... ***` on their own line.
 * Keep everything between them; fall back to the whole text if the markers
 * are missing.
 */
function stripPgBoilerplate(text: string): string {
  const startRe = /\*\*\*\s*START OF (THE |THIS )?(PROJECT GUTENBERG )?EBOOK[\s\S]*?\*\*\*/i;
  const endRe = /\*\*\*\s*END OF (THE |THIS )?(PROJECT GUTENBERG )?EBOOK[\s\S]*?\*\*\*/i;
  const startMatch = text.match(startRe);
  const endMatch = text.match(endRe);
  const bodyStart = startMatch ? (startMatch.index ?? 0) + startMatch[0].length : 0;
  const bodyEnd = endMatch ? (endMatch.index ?? text.length) : text.length;
  return text.slice(bodyStart, bodyEnd);
}

// --- D1 fetch ------------------------------------------------------

interface BookRow {
  id: string;
  gutenbergId: number;
  title: string;
  wordCount: number;
  chapterCount: number;
  qualityScore: number;
}

interface ChapterRow {
  id: string;
  bookId: string;
  orderNum: number;
  title: string;
  contentUrl: string;
  wordCount: number;
}

async function fetchReadyBooks(): Promise<BookRow[]> {
  const { data } = await axios.get(`${WORKER_BASE_URL}/internal/books`, {
    headers: { 'X-Internal-Key': INTERNAL_KEY },
    params: { status: 'ready', limit: 200 },
    timeout: 30_000,
  });
  return data as BookRow[];
}

async function fetchChapters(bookId: string): Promise<ChapterRow[]> {
  const { data } = await axios.get(`${WORKER_BASE_URL}/internal/books/${bookId}/chapters`, {
    headers: { 'X-Internal-Key': INTERNAL_KEY },
    timeout: 30_000,
  });
  return data as ChapterRow[];
}

async function fetchChapterHtml(url: string): Promise<string> {
  const { data } = await axios.get<string>(url, {
    responseType: 'text',
    timeout: 60_000,
    maxRedirects: 5,
    transformResponse: (x) => x,
  });
  return data;
}

// --- comparison ----------------------------------------------------

interface DiffResult {
  gutenbergId: number;
  title: string;
  oursWords: number;
  pgWords: number;
  wordRatio: number;
  oursChars: number;
  pgChars: number;
  alignCheck: 'OK' | 'MISS' | 'NA';
  bidirMissRate: number;
  verdict: 'OK' | 'WARN' | 'SUSPECT' | 'NO_GROUND_TRUTH' | 'ERROR';
  notes?: string;
}

function countMultiset(words: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of words) out.set(w, (out.get(w) || 0) + 1);
  return out;
}

/**
 * Symmetric multiset difference ratio.
 * 0 = identical bags of words, 1 = completely disjoint.
 * |A∆B| / (|A| + |B|)
 */
function multisetDiff(a: Map<string, number>, b: Map<string, number>): number {
  let diff = 0;
  let total = 0;
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const ac = a.get(k) || 0;
    const bc = b.get(k) || 0;
    diff += Math.abs(ac - bc);
    total += ac + bc;
  }
  return total === 0 ? 1 : diff / total;
}

function classify(wordRatio: number, align: 'OK' | 'MISS' | 'NA', miss: number): DiffResult['verdict'] {
  if (wordRatio >= 0.95 && wordRatio <= 1.05 && align !== 'MISS' && miss < 0.05) return 'OK';
  if (wordRatio >= 0.9 && wordRatio <= 1.1 && miss < 0.1) return 'WARN';
  return 'SUSPECT';
}

async function diffOne(book: BookRow): Promise<DiffResult> {
  try {
    // Our side
    const chapters = await fetchChapters(book.id);
    chapters.sort((a, b) => a.orderNum - b.orderNum);
    const htmls: string[] = [];
    for (const ch of chapters) {
      const html = await fetchChapterHtml(ch.contentUrl);
      htmls.push(html);
    }
    const oursRaw = htmls.map(stripHtml).join(' ');
    const oursNorm = normalize(oursRaw);
    const oursWords = wordList(oursNorm);

    // PG side
    const pgText = await fetchPgPlainText(book.gutenbergId);
    if (!pgText) {
      return {
        gutenbergId: book.gutenbergId,
        title: book.title,
        oursWords: oursWords.length,
        pgWords: 0,
        wordRatio: 0,
        oursChars: oursNorm.length,
        pgChars: 0,
        alignCheck: 'NA',
        bidirMissRate: 1,
        verdict: 'NO_GROUND_TRUTH',
        notes: 'PG .txt not available on either mirror',
      };
    }
    const pgBody = stripPgBoilerplate(pgText);
    const pgNorm = normalize(pgBody);
    const pgWords = wordList(pgNorm);

    const wordRatio = pgWords.length === 0 ? 0 : oursWords.length / pgWords.length;

    // Alignment check: does a 200-char slice from the middle of our first
    // chapter appear in the PG body? Middle-of-chapter avoids false negatives
    // from title pages and opening boilerplate that may differ.
    let alignCheck: DiffResult['alignCheck'] = 'NA';
    if (oursNorm.length > 600 && pgNorm.length > 600) {
      const anchor = oursNorm.slice(200, 400);
      alignCheck = pgNorm.includes(anchor) ? 'OK' : 'MISS';
    }

    const miss = multisetDiff(countMultiset(oursWords), countMultiset(pgWords));
    const verdict = classify(wordRatio, alignCheck, miss);

    return {
      gutenbergId: book.gutenbergId,
      title: book.title,
      oursWords: oursWords.length,
      pgWords: pgWords.length,
      wordRatio: Number(wordRatio.toFixed(3)),
      oursChars: oursNorm.length,
      pgChars: pgNorm.length,
      alignCheck,
      bidirMissRate: Number(miss.toFixed(3)),
      verdict,
    };
  } catch (err: any) {
    return {
      gutenbergId: book.gutenbergId,
      title: book.title,
      oursWords: 0,
      pgWords: 0,
      wordRatio: 0,
      oursChars: 0,
      pgChars: 0,
      alignCheck: 'NA',
      bidirMissRate: 1,
      verdict: 'ERROR',
      notes: err?.message || String(err),
    };
  }
}

// --- main ----------------------------------------------------------

function fmtRow(r: DiffResult): string {
  const id = String(r.gutenbergId).padStart(6);
  const title = (r.title || '').slice(0, 40).padEnd(40);
  const words = `${Math.round(r.oursWords / 1000)}k/${Math.round(r.pgWords / 1000)}k`.padEnd(12);
  const ratio = r.wordRatio.toFixed(2).padStart(5);
  const align = r.alignCheck.padEnd(5);
  const miss = `${(r.bidirMissRate * 100).toFixed(1)}%`.padStart(6);
  const verdict = r.verdict.padEnd(16);
  return `${id}  ${title}  ${words}  ${ratio}  ${align}  ${miss}  ${verdict}`;
}

async function main() {
  if (!INTERNAL_KEY) {
    console.error('WORKER_INTERNAL_KEY is not set. Copy scripts/.env on the droplet or export it locally.');
    process.exit(1);
  }

  const args = parseArgs();

  console.log(`Fetching ready books from ${WORKER_BASE_URL}...`);
  const all = await fetchReadyBooks();
  console.log(`Got ${all.length} ready books.`);

  let sample: BookRow[];
  if (args.ids) {
    sample = all.filter((b) => args.ids!.includes(b.gutenbergId));
    if (sample.length === 0) {
      console.error(`None of the requested ids were found in ready status: ${args.ids.join(',')}`);
      process.exit(1);
    }
  } else {
    const shuffled = [...all].sort(() => Math.random() - 0.5);
    sample = shuffled.slice(0, args.sample);
  }

  console.log(`\nAuditing ${sample.length} books against PG plain-text ground truth...\n`);
  console.log(
    '    PG#  Title                                     Words (ours/pg)  Ratio  Align  Miss   Verdict',
  );
  console.log(
    '  ------ ----------------------------------------  ------------  -----  -----  -----  ----------',
  );

  const results: DiffResult[] = [];
  for (const book of sample) {
    const r = await diffOne(book);
    results.push(r);
    console.log('  ' + fmtRow(r));
  }

  // Summary
  const counts: Record<DiffResult['verdict'], number> = {
    OK: 0,
    WARN: 0,
    SUSPECT: 0,
    NO_GROUND_TRUTH: 0,
    ERROR: 0,
  };
  for (const r of results) counts[r.verdict]++;

  const comparable = results.filter((r) => r.verdict !== 'NO_GROUND_TRUTH' && r.verdict !== 'ERROR');
  const okRate = comparable.length === 0 ? 0 : counts.OK / comparable.length;

  console.log('\nSummary:');
  console.log(`  OK:              ${counts.OK}`);
  console.log(`  WARN:            ${counts.WARN}`);
  console.log(`  SUSPECT:         ${counts.SUSPECT}`);
  console.log(`  NO_GROUND_TRUTH: ${counts.NO_GROUND_TRUTH}`);
  console.log(`  ERROR:           ${counts.ERROR}`);
  console.log(`  ----`);
  console.log(
    `  Extraction fidelity (OK / comparable): ${(okRate * 100).toFixed(1)}% (${counts.OK}/${comparable.length})`,
  );

  // Persist
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `diff-${stamp}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        workerBaseUrl: WORKER_BASE_URL,
        sampleSize: sample.length,
        counts,
        okRate,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outFile}`);
}

main().catch((err) => {
  console.error('fatal:', err?.message || err);
  process.exit(1);
});
