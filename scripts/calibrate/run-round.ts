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
// Cache downloaded EPUBs so re-runs don't re-hit Gutenberg (which rate
// limits aggressively on bursty downloads).
const CACHE_DIR = path.join(os.tmpdir(), 'readmigo-gutenberg-calibrate-cache');

// Calibration thresholds.
//
// Chapter count is deliberately *not* part of the strict pass condition —
// SE and PG often represent collection works differently (SE flattens all
// of Aesop's 285 fables into 2 files, while PG lists each as a separate
// entry), and we do not want those structural preferences to fail the
// alignment check. What we care about is that the pipeline recovers the
// same actual content from PG that SE curates.
//
// Word count is the strict alignment signal. 15% tolerance is generous
// enough to accept legitimate edition differences (PG often includes a
// translator's preface or appendix that SE omits) without masking real
// extraction bugs — a 35% word-count surplus like Theory of Moral
// Sentiments still fails, which is the signal we want.
const WORD_DIFF_TOLERANCE = 0.15;
const QUALITY_THRESHOLD = 80;

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
  // Only single-source SE editions are comparable — when SE lists multiple
  // gutenberg.org URLs in dc:source it has merged several PG books into
  // one curated volume (the Vicomte de Bragelonne trilogy, Ambrose Bierce
  // collected poetry, Algis Budrys short fiction, etc.), and our pipeline
  // cannot reconstruct that merge from a single PG download. We'd rather
  // skip these entries than report spurious "failures".
  return raw.entries.filter((e) => e.pgIds.length === 1);
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
  // Cache by stable key derived from URL so repeated runs / retries do not
  // hammer Gutenberg. If the cached file exists and is a valid ZIP, reuse it.
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = url.replace(/[^a-zA-Z0-9]/g, '_');
  const cachedFile = path.join(CACHE_DIR, `${prefix}-${key}.epub`);
  if (fs.existsSync(cachedFile)) {
    const existing = fs.readFileSync(cachedFile);
    if (existing.length >= 4 && existing[0] === 0x50 && existing[1] === 0x4b) {
      return cachedFile;
    }
    fs.unlinkSync(cachedFile);
  }

  // Retry transient network failures (502s, 429 rate limits, aborts, timeouts).
  // PG's www.gutenberg.org is quick to rate limit; back off aggressively on 429.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
      const buf = Buffer.from(res.data);
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        throw new Error(`downloaded file is not a ZIP/EPUB (${buf.length} bytes from ${url})`);
      }
      fs.writeFileSync(cachedFile, buf);
      return cachedFile;
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      if (attempt < 5) {
        // Exponential backoff with 429 pause: 429 means "wait" — pause 15s.
        const baseDelay = status === 429 ? 15_000 : 2000;
        await new Promise((r) => setTimeout(r, baseDelay * attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
  // SE EPUBs are curated and well-formed: one narrative segment per file
  // under epub/text/*.xhtml. We intentionally *do not* run extractChapters
  // here because it applies our front-matter filter, which would prune
  // legitimately short SE content (e.g. the 165 short poems in SE's
  // Luzumiyat edition) and yield a bogus ground truth of 0 chapters.
  //
  // Instead iterate the spine/flow directly, collect the text of each file,
  // and skip only SE's standard non-narrative files (imprint, colophon,
  // titlepage, etc.) so our count lines up with "real reading content".
  const epub = await parseEpub(epubPath);
  const flow = (epub as any).flow || [];
  const SE_NON_NARRATIVE = /(cover|titlepage|imprint|colophon|copyright|dedication|uncopyright|endnotes|halftitle)/i;

  let chapterCount = 0;
  let totalWords = 0;

  for (const item of flow) {
    const href = String(item.href || '');
    if (SE_NON_NARRATIVE.test(href)) continue;

    const content: string = await new Promise((resolve) => {
      (epub as any).getChapter(item.id, (_err: Error, text: string) => {
        resolve(text || '');
      });
    });
    if (!content) continue;
    const text = stripHtml(content);
    const wc = countWords(text);
    // Very short files on SE are typically chapter-group landing pages or
    // part dividers; they count as narrative but don't add to the text.
    if (wc === 0) continue;
    chapterCount++;
    totalWords += wc;
  }

  return { chapterCount, totalWords };
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
    // Chapter count is tracked but not asserted (see WORD_DIFF_TOLERANCE comment).
    const chapterMatch = true;
    const wordMatch = Math.abs(wordDiffPct) <= WORD_DIFF_TOLERANCE;
    const qualityMatch = pgSummary.qualityScore >= QUALITY_THRESHOLD;

    if (!wordMatch) notes.push(`word diff ${(wordDiffPct * 100).toFixed(1)}%`);
    if (!qualityMatch) notes.push(`quality score ${pgSummary.qualityScore}`);
    // Record chapter diff informationally so we can still see skew in the log.
    if (Math.abs(chapterDiff) > 5) notes.push(`chapter diff ${chapterDiff} (informational)`);

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
  }
  // No cleanup: downloaded files live in CACHE_DIR for reuse across runs.
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
    // Space out requests — PG rate-limits aggressively (hits HTTP 429 after
    // only a handful of quick downloads). 3 seconds between books keeps us
    // under the limit even for 16-book rounds.
    if (i < selected.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
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
