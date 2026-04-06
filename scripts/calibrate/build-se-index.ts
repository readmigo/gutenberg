/**
 * Build the Standard Ebooks to Project Gutenberg index.
 *
 * For every published SE ebook we need to know which PG source edition it
 * was based on, so the calibration comparison can download the SAME PG
 * source that SE used (instead of an unrelated illustrated reprint).
 *
 * Pipeline:
 *   1. Walk SE's paginated ebook listing (https://standardebooks.org/ebooks?page=N)
 *      and grep out /ebooks/{author}/{title}[/variant] slugs from each page.
 *   2. For every slug, fetch the SE GitHub repo's content.opf raw file
 *      (repo name = slug with / replaced by _) and extract the PG book ID
 *      from the <dc:source>https://www.gutenberg.org/ebooks/NNNN</dc:source>
 *      element.
 *   3. Write the combined map to scripts/calibrate/se-pg-index.json.
 *
 * This is a one-off build step; the resulting JSON is checked into git so
 * subsequent rounds of calibration can just read it.
 *
 * Usage: npx ts-node calibrate/build-se-index.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

interface IndexEntry {
  seSlug: string;
  seRepo: string;
  pgIds: number[];
}

const SE_BASE = 'https://standardebooks.org';
const GH_RAW = 'https://raw.githubusercontent.com/standardebooks';
const OUT_FILE = path.resolve(__dirname, 'se-pg-index.json');

const http = axios.create({
  timeout: 30_000,
  headers: { 'User-Agent': 'readmigo-gutenberg-calibration/1 (research)' },
  maxRedirects: 5,
});

async function getWithRetry(url: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await http.get<string>(url, { responseType: 'text' });
      return data;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) return null;
      if (attempt === 3) {
        console.error(`  fail: ${url} -> ${err?.message || status}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return null;
}

function extractSlugsFromListing(html: string): string[] {
  const re = /<a href="\/ebooks\/([a-z][a-z0-9-]+\/[a-z0-9-]+(?:\/[a-z0-9-]+)?)[^"]*"/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    found.add(m[1]);
  }
  return [...found];
}

function extractPgIds(opf: string): number[] {
  const re = /gutenberg\.org\/ebooks\/(\d+)/g;
  const ids = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(opf)) !== null) {
    ids.add(Number(m[1]));
  }
  return [...ids];
}

async function walkListingPages(): Promise<string[]> {
  const allSlugs = new Set<string>();
  let totalPages = 99;

  for (let page = 1; page <= totalPages; page++) {
    const html = await getWithRetry(`${SE_BASE}/ebooks?page=${page}`);
    if (!html) {
      console.warn(`  listing page ${page} unreachable, skipping`);
      continue;
    }
    const slugs = extractSlugsFromListing(html);
    if (slugs.length === 0) {
      console.log(`  listing page ${page} returned 0 slugs, stopping`);
      break;
    }
    for (const s of slugs) allSlugs.add(s);

    if (page === totalPages) {
      const pageNums = html.match(/page=(\d+)/g) || [];
      const lastSeen = Math.max(
        ...pageNums.map((p) => Number(p.replace('page=', ''))).filter((n) => Number.isFinite(n)),
      );
      if (lastSeen > totalPages) {
        totalPages = Math.min(lastSeen, 200);
      }
    }

    if (page % 10 === 0 || page === totalPages) {
      console.log(`  listing: page ${page}/${totalPages}, ${allSlugs.size} slugs so far`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return [...allSlugs].sort();
}

async function resolvePgIds(slugs: string[]): Promise<IndexEntry[]> {
  // Fetch with bounded concurrency so the whole batch finishes in minutes
  // instead of an hour. GitHub's raw.githubusercontent.com serves from a
  // cache with generous headroom for static file reads; 10 parallel requests
  // is well within safe limits for research usage.
  const CONCURRENCY = 10;
  const entries: IndexEntry[] = new Array(slugs.length);
  let cursor = 0;
  let resolved = 0;
  let withPgCount = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= slugs.length) return;
      const slug = slugs[i];
      const repo = slug.replace(/\//g, '_');
      const url = `${GH_RAW}/${repo}/master/src/epub/content.opf`;
      const opf = await getWithRetry(url);
      if (!opf) {
        entries[i] = { seSlug: slug, seRepo: repo, pgIds: [] };
      } else {
        const pgIds = extractPgIds(opf);
        entries[i] = { seSlug: slug, seRepo: repo, pgIds };
        if (pgIds.length > 0) withPgCount++;
      }
      resolved++;
      if (resolved % 50 === 0 || resolved === slugs.length) {
        console.log(
          `  resolve: ${resolved}/${slugs.length} (${withPgCount} with PG IDs)`,
        );
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  return entries;
}

async function main() {
  console.log('Phase 1: walking SE listing pages');
  const slugs = await walkListingPages();
  console.log(`  collected ${slugs.length} unique slugs\n`);

  console.log('Phase 2: resolving PG IDs from GitHub content.opf');
  const entries = await resolvePgIds(slugs);

  const withPg = entries.filter((e) => e.pgIds.length > 0);
  const withoutPg = entries.filter((e) => e.pgIds.length === 0);
  console.log(
    `\n  ${withPg.length} entries resolved with PG IDs, ${withoutPg.length} missing\n`,
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    totalSlugs: entries.length,
    resolvedCount: withPg.length,
    unresolvedCount: withoutPg.length,
    entries,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
