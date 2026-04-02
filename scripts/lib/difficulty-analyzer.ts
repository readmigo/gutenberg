/**
 * Difficulty analysis module for English books.
 *
 * Calculates:
 * - Flesch Reading Ease score (0-100, higher = easier)
 * - CEFR level mapping (A1-C2)
 * - Composite difficulty score (0-100, higher = harder)
 * - Estimated reading time in minutes
 */

export interface DifficultyResult {
  fleschScore: number;       // 0-100
  cefrLevel: string;         // A1, A2, B1, B2, C1, C2
  difficultyScore: number;   // 0-100 (higher = harder)
  estimatedReadingMinutes: number;
}

// Average reading speed for English text (words per minute)
const AVG_READING_WPM = 250;

// Flesch → CEFR mapping thresholds
// Based on research correlating Flesch scores with CEFR levels
const CEFR_THRESHOLDS: Array<{ min: number; level: string }> = [
  { min: 90, level: 'A1' },  // Very Easy
  { min: 80, level: 'A2' },  // Easy
  { min: 60, level: 'B1' },  // Fairly Easy / Standard
  { min: 50, level: 'B2' },  // Fairly Difficult
  { min: 30, level: 'C1' },  // Difficult
  { min: 0,  level: 'C2' },  // Very Difficult
];

/**
 * Count syllables in an English word using a heuristic approach.
 * Not perfect but reliable enough for Flesch score calculation.
 */
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 2) return 1;

  let count = 0;
  const vowels = 'aeiouy';
  let prevVowel = false;

  for (let i = 0; i < w.length; i++) {
    const isVowel = vowels.includes(w[i]);
    if (isVowel && !prevVowel) {
      count++;
    }
    prevVowel = isVowel;
  }

  // Silent e at end
  if (w.endsWith('e') && count > 1) {
    count--;
  }

  // Common suffixes that add syllables
  if (w.endsWith('le') && w.length > 2 && !vowels.includes(w[w.length - 3])) {
    count++;
  }

  // -ed ending: only adds syllable if preceded by t or d
  if (w.endsWith('ed') && w.length > 3) {
    const beforeEd = w[w.length - 3];
    if (beforeEd !== 't' && beforeEd !== 'd') {
      // -ed is silent, don't count it if we already did
      // (the vowel loop already counted 'e' in 'ed')
      // Subtract only if count > 1
      if (count > 1) count--;
    }
  }

  return Math.max(1, count);
}

/**
 * Split text into sentences. Handles common abbreviations.
 */
function splitSentences(text: string): string[] {
  // Replace common abbreviations to avoid false sentence breaks
  let t = text;
  const abbrevs = ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Sr.', 'Jr.', 'St.', 'vs.', 'etc.', 'Vol.', 'No.', 'e.g.', 'i.e.'];
  for (const a of abbrevs) {
    t = t.replaceAll(a, a.replace('.', '\x00'));
  }

  const sentences = t.split(/[.!?]+/).filter(s => s.trim().length > 0);
  return sentences;
}

/**
 * Split text into words.
 */
function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length > 0);
}

/**
 * Strip HTML tags from content.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate Flesch Reading Ease score.
 *
 * Formula: 206.835 - 1.015 * (totalWords / totalSentences) - 84.6 * (totalSyllables / totalWords)
 *
 * Score ranges:
 *   90-100: Very Easy (5th grade)
 *   80-89:  Easy (6th grade)
 *   70-79:  Fairly Easy (7th grade)
 *   60-69:  Standard (8th-9th grade)
 *   50-59:  Fairly Difficult (10th-12th grade)
 *   30-49:  Difficult (college)
 *   0-29:   Very Difficult (college graduate)
 */
function calculateFleschScore(words: string[], sentenceCount: number): number {
  if (words.length === 0 || sentenceCount === 0) return 50; // default to medium

  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const avgWordsPerSentence = words.length / sentenceCount;
  const avgSyllablesPerWord = totalSyllables / words.length;

  const score = 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;

  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

/**
 * Map Flesch score to CEFR level.
 */
function fleschToCefr(fleschScore: number): string {
  for (const { min, level } of CEFR_THRESHOLDS) {
    if (fleschScore >= min) return level;
  }
  return 'C2';
}

/**
 * Convert Flesch (0-100, higher=easier) to difficulty (0-100, higher=harder).
 */
function fleschToDifficulty(fleschScore: number): number {
  return Math.round((100 - fleschScore) * 10) / 10;
}

/**
 * Analyze difficulty of a book from its chapter HTML contents.
 *
 * @param chapterHtmls - Array of cleaned chapter HTML strings
 * @param totalWordCount - Pre-calculated total word count
 */
export function analyzeDifficulty(chapterHtmls: string[], totalWordCount: number): DifficultyResult {
  // Sample chapters for analysis (max 5 evenly spaced chapters to keep it fast)
  const sampleIndices: number[] = [];
  if (chapterHtmls.length <= 5) {
    for (let i = 0; i < chapterHtmls.length; i++) sampleIndices.push(i);
  } else {
    const step = Math.floor(chapterHtmls.length / 5);
    for (let i = 0; i < 5; i++) sampleIndices.push(i * step);
  }

  let totalWords: string[] = [];
  let totalSentences = 0;

  for (const idx of sampleIndices) {
    const plainText = stripHtml(chapterHtmls[idx]);
    const words = splitWords(plainText);
    const sentences = splitSentences(plainText);
    totalWords = totalWords.concat(words);
    totalSentences += sentences.length;
  }

  const fleschScore = calculateFleschScore(totalWords, totalSentences);
  const cefrLevel = fleschToCefr(fleschScore);
  const difficultyScore = fleschToDifficulty(fleschScore);
  const estimatedReadingMinutes = Math.max(1, Math.round(totalWordCount / AVG_READING_WPM));

  return {
    fleschScore,
    cefrLevel,
    difficultyScore,
    estimatedReadingMinutes,
  };
}
