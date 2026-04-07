import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fetchPage, fetchBookById, getEpubUrl, GutendexBook } from './lib/gutendex-client';
import { workerClient } from './lib/worker-client';
import { buildCuratedPriorityMap, getCuratedIds } from './lib/curated-lists';
import { fetchCategoryBonuses, getBookCategoryBonus } from './lib/category-balancer';
import { isExcludedFromReadmigo } from './lib/curation-rules';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const DISCOVER_LIMIT = parseInt(getArg('discover-limit', '200'));
const MIN_DOWNLOADS = parseInt(getArg('min-downloads', '10'));
const DRY_RUN = args.includes('--dry-run');
const CURATED_ONLY = args.includes('--curated-only');
const EXCLUDE_SE = args.includes('--exclude-se');

/**
 * Build the set of PG IDs that Standard Ebooks already curates. When the
 * --exclude-se flag is set we skip these books at queue time so the small
 * batch trial focuses on books outside the SE catalog.
 */
function loadSePgIds(): Set<number> {
  const indexPath = path.resolve(__dirname, 'calibrate', 'se-pg-index.json');
  if (!fs.existsSync(indexPath)) {
    console.warn(`  [exclude-se] se-pg-index.json not found at ${indexPath}, skipping filter`);
    return new Set();
  }
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
    entries: Array<{ pgIds: number[] }>;
  };
  const ids = new Set<number>();
  for (const entry of raw.entries) {
    for (const id of entry.pgIds) ids.add(id);
  }
  return ids;
}

const SE_PG_IDS = EXCLUDE_SE ? loadSePgIds() : new Set<number>();

async function main() {
  console.log('='.repeat(60));
  console.log('PG Discover - Smart Priority Strategy');
  console.log(`  Limit: ${DISCOVER_LIMIT} | Min downloads: ${MIN_DOWNLOADS} | Dry run: ${DRY_RUN}`);
  console.log(`  Curated only: ${CURATED_ONLY} | Exclude SE: ${EXCLUDE_SE} (${SE_PG_IDS.size} ids)`);
  console.log('='.repeat(60));

  // Phase 1: Discover curated books first (highest priority)
  const curatedMap = buildCuratedPriorityMap();
  const curatedIds = getCuratedIds();

  console.log(`\n[Phase 1] Checking ${curatedIds.length} curated books...`);

  let existingCurated: number[] = [];
  try {
    existingCurated = await workerClient.checkExistingBooks(curatedIds);
  } catch (err) {
    console.error('  Failed to check existing curated books:', err instanceof Error ? err.message : err);
  }

  const existingCuratedSet = new Set(existingCurated);
  const newCuratedIds = curatedIds.filter(id => !existingCuratedSet.has(id));
  console.log(`  ${newCuratedIds.length} curated books not yet in DB (${existingCurated.length} already exist)`);

  let discovered = 0;
  let skipped = 0;
  let excluded = 0;

  // Create jobs for new curated books. Each curated id is checked against
  // the Readmigo curation rules — fetch metadata from Gutendex so we can
  // see subjects/title/description before queueing. Curated books that
  // happen to be poetry collections, plays, or multi-translator anthologies
  // are skipped per docs/plans/2026-04-07-readmigo-curation-rules.md.
  for (const gutenbergId of newCuratedIds) {
    if (discovered >= DISCOVER_LIMIT) break;

    if (EXCLUDE_SE && SE_PG_IDS.has(gutenbergId)) {
      excluded++;
      continue;
    }

    let book: GutendexBook | null = null;
    try {
      book = await fetchBookById(gutenbergId);
    } catch (err) {
      console.error(`  Failed to fetch metadata for PG#${gutenbergId}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!book) {
      console.warn(`  PG#${gutenbergId} not found on Gutendex, skipping`);
      continue;
    }

    const curationCheck = isExcludedFromReadmigo({
      title: book.title,
      subjects: book.subjects,
    });
    if (curationCheck.excluded) {
      console.log(`  [skip] PG#${gutenbergId} ${book.title} — ${curationCheck.reason}`);
      excluded++;
      continue;
    }

    const priority = (curatedMap.get(gutenbergId) || 0) + 1000; // curated books always high priority

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Curated job: PG#${gutenbergId} (priority: ${priority})`);
    } else {
      try {
        await workerClient.createJob(gutenbergId, priority);
        console.log(`  Created curated job: PG#${gutenbergId} ${book.title} (priority: ${priority})`);
      } catch (err) {
        console.error(`  Failed to create job for PG#${gutenbergId}:`, err instanceof Error ? err.message : err);
        continue;
      }
    }
    discovered++;
  }

  console.log(`  Phase 1 done: ${discovered} curated books queued, ${excluded} excluded by curation rules`);

  if (CURATED_ONLY) {
    printSummary(discovered, skipped, excluded);
    return;
  }

  // Phase 2: Discover from Gutendex with category balancing
  console.log(`\n[Phase 2] Fetching category bonuses for balancing...`);
  const categoryBonuses = await fetchCategoryBonuses();

  if (categoryBonuses.size > 0) {
    console.log('  Category bonuses:');
    for (const [cat, bonus] of [...categoryBonuses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${cat}: +${bonus}`);
    }
  }

  console.log(`\n[Phase 2] Browsing Gutendex (min downloads: ${MIN_DOWNLOADS})...`);

  let consecutiveAllExist = 0;
  let page = 1;

  while (discovered < DISCOVER_LIMIT) {
    console.log(`\n  Page ${page}...`);

    let response;
    try {
      response = await fetchPage(page);
    } catch (err) {
      console.error(`  Failed to fetch page ${page}:`, err instanceof Error ? err.message : err);
      break;
    }

    if (response.results.length === 0) {
      console.log('  No more results.');
      break;
    }

    // Filter: has EPUB, meets min downloads
    const candidates = response.results.filter((b) => getEpubUrl(b) && b.download_count >= MIN_DOWNLOADS);

    if (candidates.length === 0) {
      console.log('  No candidates on this page (below min downloads threshold).');
      break;
    }

    // Check which already exist
    const gutenbergIds = candidates.map((b) => b.id);
    let existingIds: number[] = [];
    try {
      existingIds = await workerClient.checkExistingBooks(gutenbergIds);
    } catch (err) {
      console.error('  Failed to check existing books:', err instanceof Error ? err.message : err);
      break;
    }

    const existingSet = new Set(existingIds);
    const newBooks = candidates.filter((b) => !existingSet.has(b.id));

    console.log(`  Found ${candidates.length} candidates, ${newBooks.length} new, ${existingSet.size} existing`);

    if (newBooks.length === 0) {
      consecutiveAllExist++;
      if (consecutiveAllExist >= 5) {
        console.log('\n  5 consecutive pages with no new books. Stopping.');
        break;
      }
    } else {
      consecutiveAllExist = 0;
    }

    // Calculate composite priority and create jobs
    for (const book of newBooks) {
      if (discovered >= DISCOVER_LIMIT) break;

      // SE-exclusion gate: when --exclude-se is set, skip books whose PG ID
      // appears in scripts/calibrate/se-pg-index.json. Used by the Stage 1
      // small batch trial to focus on books that SE has not curated.
      if (EXCLUDE_SE && SE_PG_IDS.has(book.id)) {
        excluded++;
        continue;
      }

      // Curation gate: skip categories the Readmigo reader does not yet
      // render well. See docs/plans/2026-04-07-readmigo-curation-rules.md.
      const curationCheck = isExcludedFromReadmigo({
        title: book.title,
        subjects: book.subjects,
      });
      if (curationCheck.excluded) {
        console.log(`  [skip] PG#${book.id} ${book.title} — ${curationCheck.reason}`);
        excluded++;
        continue;
      }

      // Composite priority = download_count + curated bonus + category bonus
      const curatedBonus = curatedMap.get(book.id) || 0;
      const categoryBonus = getBookCategoryBonus(book, categoryBonuses);
      const priority = book.download_count + curatedBonus + categoryBonus;

      if (DRY_RUN) {
        const bonusInfo = curatedBonus ? ` +curated:${curatedBonus}` : '';
        const catInfo = categoryBonus ? ` +cat:${categoryBonus}` : '';
        console.log(`  [DRY RUN] ${book.title} (DL: ${book.download_count}${bonusInfo}${catInfo} = ${priority})`);
      } else {
        try {
          await workerClient.createJob(book.id, priority);
          const bonusInfo = curatedBonus ? ` +curated:${curatedBonus}` : '';
          const catInfo = categoryBonus ? ` +cat:${categoryBonus}` : '';
          console.log(`  Created job: ${book.title} (DL: ${book.download_count}${bonusInfo}${catInfo} = ${priority})`);
        } catch (err) {
          console.error(`  Failed to create job for ${book.title}:`, err instanceof Error ? err.message : err);
          continue;
        }
      }
      discovered++;
    }

    skipped += existingSet.size;
    page++;

    // Small delay between pages
    await new Promise((r) => setTimeout(r, 1000));
  }

  printSummary(discovered, skipped, excluded);
}

function printSummary(discovered: number, skipped: number, excluded: number) {
  console.log('\n' + '='.repeat(60));
  console.log(`Summary: ${discovered} discovered, ${skipped} already exist, ${excluded} excluded by curation rules`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Discover failed:', err);
  process.exit(1);
});
