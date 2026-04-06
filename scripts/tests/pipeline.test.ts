import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseEpub, extractMetadata, extractChapters } from '../lib/epub-parser';
import { cleanChapterHtml } from '../lib/content-cleaner';
import { typographize } from '../lib/typographer';
import { modernizeSpelling } from '../lib/spelling-modernizer';
import { semanticize } from '../lib/semanticizer';
import { tagForeignPhrases } from '../lib/foreign-tagger';
import { checkBookQuality } from '../lib/quality-checker';

// ---- Helpers ---------------------------------------------------------------

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

interface ChapterSummary {
  order: number;
  title: string;
  wordCount: number;
  sample: string; // first 160 chars of stripped text
}

interface BookSummary {
  title: string;
  author: string;
  language: string;
  chapterCount: number;
  totalWords: number;
  qualityScore: number;
  qualityTier: string;
  qualityPass: boolean;
  qualityIssues: string[];
  chapters: ChapterSummary[];
}

/**
 * Run the full end-to-end pipeline against an EPUB file and collect a
 * compact summary suitable for snapshot comparison. Avoids storing full
 * HTML content (too large and too noisy) in favor of invariants that
 * catch real regressions: chapter count, word counts, titles, and a
 * stable text sample from each chapter.
 */
async function runPipeline(epubPath: string): Promise<BookSummary> {
  const epub = await parseEpub(epubPath);
  const metadata = extractMetadata(epub);
  const rawChapters = await extractChapters(epub);

  const cleaned = rawChapters.map((ch) => {
    const a = cleanChapterHtml(ch.htmlContent);
    const b = typographize(a);
    const c = modernizeSpelling(b);
    const d = semanticize(c);
    const e = tagForeignPhrases(d);
    const text = stripHtml(e);
    return {
      order: ch.order,
      title: ch.title,
      wordCount: countWords(text),
      htmlContent: e,
      sample: text.slice(0, 160),
    };
  });

  const totalWords = cleaned.reduce((s, c) => s + c.wordCount, 0);

  const quality = checkBookQuality(
    {
      title: metadata.title,
      chapterCount: cleaned.length,
      wordCount: totalWords,
      hasCover: true,
    },
    cleaned.map((c) => ({
      title: c.title,
      wordCount: c.wordCount,
      htmlContent: c.htmlContent,
    })),
  );

  return {
    title: metadata.title,
    author: metadata.author,
    language: metadata.language,
    chapterCount: cleaned.length,
    totalWords,
    qualityScore: quality.score,
    qualityTier: quality.tier,
    qualityPass: quality.pass,
    qualityIssues: quality.issues,
    chapters: cleaned.map((c) => ({
      order: c.order,
      title: c.title,
      wordCount: c.wordCount,
      sample: c.sample,
    })),
  };
}

// ---- Snapshot plumbing -----------------------------------------------------
//
// We roll our own snapshot file format instead of using vitest's built-in
// snapshots because:
//   1. We want the snapshot to be human-readable JSON, easy to diff in PRs.
//   2. We want a single file per fixture, not a consolidated .snap blob.
//   3. We want regenerating to be explicit (UPDATE_SNAPSHOTS=1), not
//      accidental on first run.

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SNAPSHOTS_DIR = path.resolve(__dirname, 'snapshots');

function snapshotPath(fixtureName: string): string {
  return path.join(SNAPSHOTS_DIR, fixtureName.replace(/\.epub$/, '.json'));
}

function loadSnapshot(fixtureName: string): BookSummary | null {
  const p = snapshotPath(fixtureName);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeSnapshot(fixtureName: string, data: BookSummary): void {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  fs.writeFileSync(snapshotPath(fixtureName), JSON.stringify(data, null, 2) + '\n');
}

interface FixtureSpec {
  file: string;
  label: string;
  // Hard invariants enforced in addition to the full snapshot — these are
  // sanity bounds so that even if someone regenerates the snapshot they
  // can't accidentally blue-line a catastrophic regression.
  minChapters: number;
  maxChapters: number;
  minWords: number;
  maxWords: number;
}

const FIXTURES: FixtureSpec[] = [
  {
    file: 'pg-1342-pride-and-prejudice.epub',
    label: 'Pride and Prejudice — PG illustrated (multi-chapter per file)',
    // SE has 61 chapters; we expect the anchor splitter to recover them
    // plus the title-page segment. Allow a small +/- window.
    minChapters: 55,
    maxChapters: 70,
    // SE: 121,778 words. PG with semanticizer/typographer insertions: ~123k.
    minWords: 100_000,
    maxWords: 140_000,
  },
  {
    file: 'pg-84-frankenstein.epub',
    label: 'Frankenstein — PG (letters + nested narratives)',
    minChapters: 20,
    maxChapters: 40,
    minWords: 60_000,
    maxWords: 90_000,
  },
  {
    file: 'pg-11-alice.epub',
    label: "Alice in Wonderland — PG (verse + illustrations)",
    minChapters: 10,
    maxChapters: 20,
    minWords: 20_000,
    maxWords: 40_000,
  },
  {
    file: 'se-pride-and-prejudice.epub',
    label: 'Pride and Prejudice — Standard Ebooks (single chapter per file)',
    minChapters: 58,
    maxChapters: 65,
    minWords: 115_000,
    maxWords: 130_000,
  },
];

// ---- Test suite -----------------------------------------------------------

const allFixturesPresent = FIXTURES.every((f) =>
  fs.existsSync(path.join(FIXTURES_DIR, f.file)),
);

describe.skipIf(!allFixturesPresent)('pipeline golden snapshots', () => {
  beforeAll(() => {
    if (!allFixturesPresent) {
      console.warn(
        '[pipeline.test] one or more fixtures missing. ' +
          'Run `pnpm test:fixtures` to download them.',
      );
    }
  });

  for (const fx of FIXTURES) {
    it(fx.label, async () => {
      const fixturePath = path.join(FIXTURES_DIR, fx.file);
      const summary = await runPipeline(fixturePath);

      // Hard invariants first: if these fail the snapshot is probably
      // also wrong and should not be auto-updated.
      expect(summary.chapterCount).toBeGreaterThanOrEqual(fx.minChapters);
      expect(summary.chapterCount).toBeLessThanOrEqual(fx.maxChapters);
      expect(summary.totalWords).toBeGreaterThanOrEqual(fx.minWords);
      expect(summary.totalWords).toBeLessThanOrEqual(fx.maxWords);

      // No chapter should be empty and no two chapters should share
      // identical text content (this is what the duplication bug looked
      // like on Pride and Prejudice before the fix).
      const samples = new Set<string>();
      for (const ch of summary.chapters) {
        expect(ch.wordCount).toBeGreaterThan(0);
        expect(ch.sample.length).toBeGreaterThan(0);
        if (ch.sample.length >= 80) {
          expect(samples.has(ch.sample)).toBe(false);
          samples.add(ch.sample);
        }
      }

      // Full snapshot comparison (exact match) once invariants pass.
      const existing = loadSnapshot(fx.file);
      if (process.env.UPDATE_SNAPSHOTS === '1' || !existing) {
        writeSnapshot(fx.file, summary);
        if (!existing) {
          console.log(`[pipeline.test] created new snapshot for ${fx.file}`);
        } else {
          console.log(`[pipeline.test] updated snapshot for ${fx.file}`);
        }
        return;
      }

      expect(summary).toEqual(existing);
    });
  }
});
