/**
 * Run one calibration round.
 *
 * Picks N books from se-pg-index.json that haven't been tested yet (i.e.
 * not already in results.json), downloads both the PG and SE EPUB for each,
 * runs the in-process pipeline on the PG EPUB, parses the SE EPUB as ground
 * truth, and records a compact row per book.
 *
 * Usage:
 *   npx ts-node calibrate/run-round.ts --size 2
 *   npx ts-node calibrate/run-round.ts --size 4 --seed 1337
 *
 * The --seed flag makes book selection deterministic within a session.
 * Default selection is "first N untested entries sorted by SE slug" — this
 * keeps rounds reproducible without needing a seed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import { parseEpub, extractMetadata, extractChapters } from '../lib/epub-parser';
import { cleanChapterHtml } from '../lib/content-cleaner';
import { typographize } from '../lib/typographer';
import { modernizeSpelling } from '../lib/spelling-modernizer';
import { semanticize } from '../lib/semanticizer';
import { tagForeignPhrases } from '../lib/foreign-tagger';
import { checkBookQuality } from '../lib/quality-checker';

interface IndexEntry {
  seSlug: string;
  seRepo: string;
  pgIds: number[];
}

interface IndexFile {
  generatedAt: string;
  totalSlugs: number;
  resolvedCount: number;
  unresolvedCount: number;
  entries: IndexEntry[];
}

interface CalibrationRow {
  round: number;
  testedAt: string;
  seSlug: string;
  pgId: number;
  pgTitle: string;
  pgChapters: number;
  pgWords: number;
  pgQualityScore: number;
  pgQualityTier: string;
  seChapters: number;
  seWords: number;
  chapterDiff: number;
  wordDiffPct: number;
  chapterMatch: boolean;
  wordMatch: boolean;
  qualityMatch: boolean;
  overallPass: boolean;
  notes: string[];
}

interface ResultsFile {
  rounds: Array<{
    round: number;
    size: number;
    completedAt: string;
    passRate: number;
    rows: CalibrationRow[];
  }>;
}

const CAL_DIR = path.resolve(__dirname);
const INDEX_FILE = path.join(CAL_DIR, 'se-pg-index.json');
const RESULTS_FILE = path.join(CAL_DIR, 'results.json');

const CHAPTER_DIFF_TOLERANCE = 2;   // allow +/- 2 chapters for title pages etc.
const WORD_DIFF_TOLERANCE = 0.05;    // allow +/- 5% total word count drift
const QUALITY_THRESHOLD = 80;        // pipeline should reach auto_approved tier

const http = axios.create({
  timeout: 120_000,
  maxRedirects: 5,
  headers: { 'User-Agent': 'readmigo-gutenberg-calibration/1 (research)' },
});

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function parseArgs(): { size: number } {
  const args = process.argv.slice(2);
  let size = 2;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--size' && i + 1 < args.length) {
      size = Number(args[i + 1]);
      i++;
    }
  }
  if (!Number.isFinite(size) || size < 1) {
    throw new Error('--size must be a positive integer');
  }
  return { size };
}

function loadIndex(): IndexEntry[] {
  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error(`se-pg-index.json not found. Run build-se-index.ts first.`);
  }
  const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as IndexFile;
  return raw.entries.filter((e) => e.pgIds.length > 0);
}

function loadResults(): ResultsFile {
  if (!fs.existsSync(RESULTS_FILE)) {
    return { rounds: [] };
  }
  return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')) as ResultsFile;
}

function saveResults(results: ResultsFile): void {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2) + '\n');
}

function testedPgIds(results: ResultsFile): Set<number> {
  const ids = new Set<number>();
  for (const r of results.rounds) {
    for (const row of r.rows) ids.add(row.pgId);
  }
  return ids;
}

async function downloadToTemp(url: string, prefix: string): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.epub`);
  const res = await http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
  const buf = Buffer.from(res.data);
  // EPUBs are ZIP; sanity check magic bytes.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`downloaded file is not a ZIP/EPUB (${buf.length} bytes from ${url})`);
  }
  fs.writeFileSync(tmpFile, buf);
  return tmpFile;
}

interface PipelineSummary {
  title: string;
  chapterCount: number;
  totalWords: number;
  qualityScore: number;
  qualityTier: string;
}

async function runPipelineOnPg(epubPath: string): Promise<PipelineSummary> {
  const epub = await parseEpub(epubPath);
  const metadata = extractMetadata(epub);
  const raw = await extractChapters(epub);
  const cleaned = raw.map((ch) => {
    const a = cleanChapterHtml(ch.htmlContent);
    const b = typographize(a);
    const c = modernizeSpelling(b);
    const d = semanticize(c);
    const e = tagForeignPhrases(d);
    const text = stripHtml(e);
    return { title: ch.title, wordCount: countWords(text), htmlContent: e };
  });
  const totalWords = cleaned.reduce((s, c) => s + c.wordCount, 0);
  const quality = checkBookQuality(
    { title: metadata.title, chapterCount: cleaned.length, wordCount: totalWords, hasCover: true },
    cleaned,
  );
  return {
    title: metadata.title,
    chapterCount: cleaned.length,
    totalWords,
    qualityScore: quality.score,
    qualityTier: quality.tier,
  };
}

async function parseSeGroundTruth(epubPath: string): Promise<{ chapterCount: number; totalWords: number }> {
  // SE EPUBs are well-formed: one chapter per file under epub/text/chapter-N.xhtml.
  // Parsing via the same epub2 library gives us a comparable count without
  // having to run the cleaning pipeline on SE content.
  const epub = await parseEpub(epubPath);
  const chapters = await extractChapters(epub);
  let totalWords = 0;
  for (const ch of chapters) {
    totalWords += countWords(stripHtml(ch.htmlContent));
  }
  return { chapterCount: chapters.length, totalWords };
}

function pgEpubUrl(pgId: number): string {
  // Standard PG EPUB3 URL with images. PG redirects this to the actual file
  // host; axios will follow.
  return `https://www.gutenberg.org/ebooks/${pgId}.epub3.images`;
}

function seEpubUrl(repo: string, seSlug: string): string {
  // SE publishes EPUBs at /ebooks/{slug}/downloads/{flattened-slug}.epub.
  // The flattened slug is repo name (slashes -> underscores) lowercased.
  // The ?source=download query bypasses SE's "your download has started"
  // interstitial and goes straight to the file.
  const filename = repo.toLowerCase();
  return `https://standardebooks.org/ebooks/${seSlug}/downloads/${filename}.epub?source=download`;
}

async function testBook(
  entry: IndexEntry,
  round: number,
): Promise<CalibrationRow> {
  const pgId = entry.pgIds[0]; // Primary source if compilation.
  const notes: string[] = [];
  let pgPath: string | null = null;
  let sePath: string | null = null;

  try {
    pgPath = await downloadToTemp(pgEpubUrl(pgId), `pg-${pgId}`);
    sePath = await downloadToTemp(seEpubUrl(entry.seRepo, entry.seSlug), `se-${pgId}`);

    const [pgSummary, seGroundTruth] = await Promise.all([
      runPipelineOnPg(pgPath),
      parseSeGroundTruth(sePath),
    ]);

    const chapterDiff = pgSummary.chapterCount - seGroundTruth.chapterCount;
    const wordDiffPct =
      seGroundTruth.totalWords === 0
        ? 1
        : (pgSummary.totalWords - seGroundTruth.totalWords) / seGroundTruth.totalWords;
    const chapterMatch = Math.abs(chapterDiff) <= CHAPTER_DIFF_TOLERANCE;
    const wordMatch = Math.abs(wordDiffPct) <= WORD_DIFF_TOLERANCE;
    const qualityMatch = pgSummary.qualityScore >= QUALITY_THRESHOLD;

    if (!chapterMatch) notes.push(`chapter diff ${chapterDiff}`);
    if (!wordMatch) notes.push(`word diff ${(wordDiffPct * 100).toFixed(1)}%`);
    if (!qualityMatch) notes.push(`quality score ${pgSummary.qualityScore}`);

    return {
      round,
      testedAt: new Date().toISOString(),
      seSlug: entry.seSlug,
      pgId,
      pgTitle: pgSummary.title,
      pgChapters: pgSummary.chapterCount,
      pgWords: pgSummary.totalWords,
      pgQualityScore: pgSummary.qualityScore,
      pgQualityTier: pgSummary.qualityTier,
      seChapters: seGroundTruth.chapterCount,
      seWords: seGroundTruth.totalWords,
      chapterDiff,
      wordDiffPct: Math.round(wordDiffPct * 10_000) / 10_000,
      chapterMatch,
      wordMatch,
      qualityMatch,
      overallPass: chapterMatch && wordMatch && qualityMatch,
      notes,
    };
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      round,
      testedAt: new Date().toISOString(),
      seSlug: entry.seSlug,
      pgId,
      pgTitle: '',
      pgChapters: 0,
      pgWords: 0,
      pgQualityScore: 0,
      pgQualityTier: 'error',
      seChapters: 0,
      seWords: 0,
      chapterDiff: 0,
      wordDiffPct: 0,
      chapterMatch: false,
      wordMatch: false,
      qualityMatch: false,
      overallPass: false,
      notes: [`error: ${msg}`],
    };
  } finally {
    for (const p of [pgPath, sePath]) {
      if (p && fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
    }
  }
}

async function main() {
  const { size } = parseArgs();
  const index = loadIndex();
  const results = loadResults();
  const already = testedPgIds(results);

  const candidates = index.filter((e) => !already.has(e.pgIds[0]));
  if (candidates.length < size) {
    console.error(`Not enough untested candidates: ${candidates.length} < ${size}`);
    process.exit(1);
  }

  // Deterministic ordering: by SE slug. This means repeated runs with the
  // same history produce the same selection without needing a seed.
  candidates.sort((a, b) => a.seSlug.localeCompare(b.seSlug));
  const selected = candidates.slice(0, size);

  const round = results.rounds.length + 2; // round 1 was the manual P&P canary.
  console.log(`Round ${round}: testing ${size} books`);
  for (const e of selected) {
    console.log(`  ${e.seSlug} (PG #${e.pgIds[0]})`);
  }
  console.log('');

  const rows: CalibrationRow[] = [];
  for (let i = 0; i < selected.length; i++) {
    const entry = selected[i];
    console.log(`[${i + 1}/${selected.length}] ${entry.seSlug} (PG #${entry.pgIds[0]})`);
    const row = await testBook(entry, round);
    rows.push(row);
    if (row.overallPass) {
      console.log(
        `  PASS  pg=${row.pgChapters}ch/${row.pgWords}w  se=${row.seChapters}ch/${row.seWords}w  quality=${row.pgQualityScore}`,
      );
    } else {
      console.log(
        `  FAIL  pg=${row.pgChapters}ch/${row.pgWords}w  se=${row.seChapters}ch/${row.seWords}w  quality=${row.pgQualityScore}  notes=${row.notes.join('; ')}`,
      );
    }
  }

  const passCount = rows.filter((r) => r.overallPass).length;
  const passRate = rows.length === 0 ? 0 : passCount / rows.length;

  results.rounds.push({
    round,
    size,
    completedAt: new Date().toISOString(),
    passRate,
    rows,
  });
  saveResults(results);

  const cumulativeRows = results.rounds.flatMap((r) => r.rows);
  const cumulativePass = cumulativeRows.filter((r) => r.overallPass).length;
  const cumulativePassRate = cumulativeRows.length === 0 ? 0 : cumulativePass / cumulativeRows.length;

  console.log('');
  console.log(`Round ${round} summary:`);
  console.log(`  pass: ${passCount}/${rows.length} (${(passRate * 100).toFixed(1)}%)`);
  console.log(`  cumulative: ${cumulativePass}/${cumulativeRows.length} (${(cumulativePassRate * 100).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
