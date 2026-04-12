/**
 * Chinese text difficulty analysis module.
 *
 * Uses jieba-wasm for word segmentation and HSK vocabulary lists
 * to estimate difficulty of Chinese text.
 *
 * Calculates:
 * - HSK level distribution across segmented words
 * - Dominant HSK level (1-6)
 * - Average sentence length
 * - Composite difficulty score (0-100, higher = harder)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ZhDifficultyResult {
  charCount: number;
  wordCount: number;
  hskDistribution: Record<string, number>;  // { "1": 120, "2": 80, ... "unknown": 50 }
  hskLevel: number;           // dominant HSK level 1-6
  avgSentenceLength: number;
  difficultyScore: number;    // 0-100
}

// Jieba module reference — loaded once via initJieba()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let jiebaModule: any = null;

/**
 * Build a word→HSK level map from the hsk-vocab.json file.
 * Keys are Chinese words, values are level numbers (1-6).
 */
function buildHskMap(): Map<string, number> {
  const vocabPath = path.join(__dirname, 'hsk-vocab.json');
  const raw = fs.readFileSync(vocabPath, 'utf8');
  const vocab: Record<string, string[]> = JSON.parse(raw);

  const map = new Map<string, number>();
  for (const [level, words] of Object.entries(vocab)) {
    const lvl = parseInt(level, 10);
    for (const word of words) {
      // Lower levels take precedence if a word appears at multiple levels
      if (!map.has(word)) {
        map.set(word, lvl);
      }
    }
  }
  return map;
}

// Lazy-initialized HSK map (shared across calls)
let hskMap: Map<string, number> | null = null;

function getHskMap(): Map<string, number> {
  if (!hskMap) {
    hskMap = buildHskMap();
  }
  return hskMap;
}

/**
 * Strip HTML tags and common HTML entities from a string.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split Chinese text into sentences using common Chinese punctuation.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？；\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Initialize jieba-wasm. Must be called once before analyzeZhDifficulty.
 */
export async function initJieba(): Promise<void> {
  if (jiebaModule) return;
  jiebaModule = require('jieba-wasm');
}

/**
 * Analyze difficulty of a Chinese text string.
 *
 * Scoring weights:
 *   - HSK level component (40%): weighted average HSK level of known words, scaled to 0-100
 *   - Unknown word ratio (40%): fraction of words not found in HSK 1-6
 *   - Average sentence length (20%): sentences longer than 20 chars considered harder
 *
 * @param text - Raw or HTML Chinese text
 * @returns ZhDifficultyResult
 */
export function analyzeZhDifficulty(text: string): ZhDifficultyResult {
  if (!jiebaModule) {
    throw new Error('jieba-wasm not initialized. Call initJieba() first.');
  }

  const plain = stripHtml(text);
  const charCount = plain.replace(/\s/g, '').length;

  // Segment text into words
  const words: string[] = jiebaModule.cut(plain, false) as string[];

  // Filter to meaningful tokens (skip pure whitespace / punctuation)
  const tokens = words.filter(w => w.trim().length > 0 && /\S/.test(w));
  const wordCount = tokens.length;

  // Map words to HSK levels
  const map = getHskMap();
  const distribution: Record<string, number> = {
    '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, 'unknown': 0,
  };

  let hskWeightedSum = 0;
  let hskKnownCount = 0;

  for (const token of tokens) {
    const level = map.get(token);
    if (level !== undefined) {
      distribution[String(level)] = (distribution[String(level)] ?? 0) + 1;
      hskWeightedSum += level;
      hskKnownCount++;
    } else {
      distribution['unknown'] = (distribution['unknown'] ?? 0) + 1;
    }
  }

  // Dominant HSK level: weighted average of known words, rounded
  const avgHskLevel = hskKnownCount > 0
    ? hskWeightedSum / hskKnownCount
    : 6; // all unknown → assume hardest
  const hskLevel = Math.min(6, Math.max(1, Math.round(avgHskLevel)));

  // Average sentence length
  const sentences = splitSentences(plain);
  const avgSentenceLength = sentences.length > 0
    ? plain.replace(/\s/g, '').length / sentences.length
    : 0;

  // Unknown word ratio (0-1)
  const unknownRatio = wordCount > 0
    ? distribution['unknown'] / wordCount
    : 0;

  // Difficulty score components (each 0-100)
  // HSK level component: level 1 → ~16, level 6 → ~100
  const hskComponent = ((avgHskLevel - 1) / 5) * 100;

  // Unknown ratio component: 0% unknown → 0, 100% unknown → 100
  const unknownComponent = unknownRatio * 100;

  // Sentence length component: 0 chars/sentence → 0, 40+ chars/sentence → 100
  const sentLenComponent = Math.min(100, (avgSentenceLength / 40) * 100);

  const difficultyScore = Math.round(
    hskComponent * 0.4 +
    unknownComponent * 0.4 +
    sentLenComponent * 0.2
  );

  return {
    charCount,
    wordCount,
    hskDistribution: distribution,
    hskLevel,
    avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
    difficultyScore: Math.max(0, Math.min(100, difficultyScore)),
  };
}
