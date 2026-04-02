/**
 * Category balancer for book discovery.
 *
 * Fetches current subject distribution from the Worker API,
 * identifies underrepresented categories, and calculates
 * priority bonuses for books in those categories.
 */

import { workerClient } from './worker-client';
import { GutendexBook } from './gutendex-client';

// Target distribution (roughly equal with slight bias toward popular categories)
const TARGET_DISTRIBUTION: Record<string, number> = {
  'Fiction': 15,
  'Science Fiction': 8,
  'Fantasy': 6,
  'Mystery & Detective': 8,
  'Horror & Gothic': 5,
  'Romance': 5,
  'Adventure': 8,
  'History': 7,
  'Philosophy': 5,
  'Science': 5,
  'Poetry': 5,
  'Drama': 5,
  'Religion': 3,
  'Politics': 3,
  'Economics': 2,
  'Children & Education': 5,
  'Biography': 4,
  'Travel': 3,
  'War & Military': 3,
  'Humor & Satire': 3,
};

// Max bonus for severely underrepresented categories
const MAX_CATEGORY_BONUS = 300;

interface SubjectStats {
  totalBooks: number;
  subjects: Record<string, number>;
}

// Normalize a Gutendex subject string to our broad categories
function normalizeSubject(subject: string): string | null {
  const s = subject.toLowerCase();
  if (s.includes('fiction') && !s.includes('non-fiction') && !s.includes('science fiction')) return 'Fiction';
  if (s.includes('science fiction') || s.includes('dystopi')) return 'Science Fiction';
  if (s.includes('fantasy') || s.includes('fairy tale')) return 'Fantasy';
  if (s.includes('mystery') || s.includes('detective')) return 'Mystery & Detective';
  if (s.includes('horror') || s.includes('ghost') || s.includes('gothic')) return 'Horror & Gothic';
  if (s.includes('romance') || s.includes('love stor')) return 'Romance';
  if (s.includes('adventure')) return 'Adventure';
  if (s.includes('histor')) return 'History';
  if (s.includes('philosophy') || s.includes('ethics')) return 'Philosophy';
  if (s.includes('science') || s.includes('natural history') || s.includes('biology') || s.includes('physics')) return 'Science';
  if (s.includes('poetry') || s.includes('poems')) return 'Poetry';
  if (s.includes('drama') || s.includes('plays') || s.includes('comedy') || s.includes('tragedy')) return 'Drama';
  if (s.includes('religion') || s.includes('bible') || s.includes('christian') || s.includes('theolog')) return 'Religion';
  if (s.includes('political') || s.includes('politics') || s.includes('government')) return 'Politics';
  if (s.includes('economics') || s.includes('commerce') || s.includes('trade')) return 'Economics';
  if (s.includes('education') || s.includes('children')) return 'Children & Education';
  if (s.includes('biography') || s.includes('autobiograph') || s.includes('memoir')) return 'Biography';
  if (s.includes('travel') || s.includes('voyage')) return 'Travel';
  if (s.includes('war') || s.includes('military')) return 'War & Military';
  if (s.includes('humor') || s.includes('satir')) return 'Humor & Satire';
  return null;
}

/**
 * Fetch current subject distribution and compute category bonuses.
 * Returns a map of category → bonus value.
 */
export async function fetchCategoryBonuses(): Promise<Map<string, number>> {
  const bonusMap = new Map<string, number>();

  let stats: SubjectStats;
  try {
    const resp = await (workerClient as any).http.get('/internal/stats/subjects');
    stats = resp.data;
  } catch (err) {
    console.warn('  [category-balancer] Failed to fetch subject stats, using flat bonuses');
    // Fallback: give moderate bonus to all non-Fiction categories
    for (const [cat, target] of Object.entries(TARGET_DISTRIBUTION)) {
      if (cat !== 'Fiction') bonusMap.set(cat, 100);
    }
    return bonusMap;
  }

  if (stats.totalBooks === 0) {
    // Empty library: all categories get equal bonus
    for (const cat of Object.keys(TARGET_DISTRIBUTION)) {
      bonusMap.set(cat, MAX_CATEGORY_BONUS / 2);
    }
    return bonusMap;
  }

  // Calculate current percentage for each category
  const totalTarget = Object.values(TARGET_DISTRIBUTION).reduce((s, v) => s + v, 0);

  for (const [category, targetPct] of Object.entries(TARGET_DISTRIBUTION)) {
    const currentCount = stats.subjects[category] || 0;
    const currentPct = (currentCount / stats.totalBooks) * 100;
    const targetPctNorm = (targetPct / totalTarget) * 100;

    // Gap = how far below target we are (0 if at or above target)
    const gap = Math.max(0, targetPctNorm - currentPct);
    // Scale gap to bonus (bigger gap = bigger bonus)
    const bonus = Math.round((gap / targetPctNorm) * MAX_CATEGORY_BONUS);

    if (bonus > 0) {
      bonusMap.set(category, Math.min(bonus, MAX_CATEGORY_BONUS));
    }
  }

  return bonusMap;
}

/**
 * Calculate category bonus for a specific Gutendex book.
 */
export function getBookCategoryBonus(book: GutendexBook, categoryBonuses: Map<string, number>): number {
  let maxBonus = 0;
  for (const subject of book.subjects) {
    const normalized = normalizeSubject(subject);
    if (normalized) {
      const bonus = categoryBonuses.get(normalized) || 0;
      maxBonus = Math.max(maxBonus, bonus);
    }
  }
  return maxBonus;
}
