export interface QualityResult {
  score: number; // 0-100
  issues: string[];
  pass: boolean; // score >= 60
}

interface BookData {
  title: string;
  chapterCount: number;
  wordCount: number;
  hasCover: boolean;
}

interface ChapterData {
  title: string;
  wordCount: number;
  htmlContent: string;
}

// Detect mojibake / encoding issues
function hasMojibake(text: string): boolean {
  const mojibakePatterns = [
    /Ã¤|Ã¶|Ã¼|Ã©|Ã¨|Ã /g,
    /â€"|â€™|â€œ|â€/g,
    /Â /g,
    /\uFFFD/,                // Unicode replacement character
    /[\x80-\x9F]/,           // Windows-1252 control characters in Unicode
    /Ã[\u0080-\u00BF]/,      // UTF-8 decoded as Latin-1
    /Â[^\s]/,               // Non-breaking space mojibake variants
  ];
  return mojibakePatterns.some((p) => p.test(text));
}

export function checkBookQuality(book: BookData, chapters: ChapterData[]): QualityResult {
  const issues: string[] = [];
  let score = 100;

  // Chapter count check
  if (chapters.length === 0) {
    issues.push('No chapters extracted');
    score -= 50;
  } else if (chapters.length < 2) {
    issues.push(`Very few chapters: ${chapters.length}`);
    score -= 15;
  }

  // Word count check
  if (book.wordCount < 1000) {
    issues.push(`Very low word count: ${book.wordCount}`);
    score -= 30;
  } else if (book.wordCount < 5000) {
    issues.push(`Low word count: ${book.wordCount}`);
    score -= 10;
  }

  // Empty chapters
  const emptyChapters = chapters.filter((c) => c.wordCount < 50);
  if (emptyChapters.length > 0) {
    issues.push(`${emptyChapters.length} near-empty chapters (< 50 words)`);
    score -= emptyChapters.length * 5;
  }

  // Cover check
  if (!book.hasCover) {
    issues.push('No cover image');
    score -= 10;
  }

  // Encoding check (all chapters)
  for (const ch of chapters) {
    if (hasMojibake(ch.htmlContent)) {
      issues.push(`Encoding issues detected in chapter: ${ch.title}`);
      score -= 15;
      break;
    }
  }

  // --- Content integrity checks ---

  // 1. Duplicate chapter titles
  const titles = chapters.map(c => c.title.trim().toLowerCase()).filter(t => t);
  const titleSet = new Set<string>();
  const duplicateTitles = titles.filter(t => {
    if (titleSet.has(t)) return true;
    titleSet.add(t);
    return false;
  });
  if (duplicateTitles.length > 0) {
    issues.push(`Duplicate chapter titles detected: ${[...new Set(duplicateTitles)].join(', ')}`);
    score -= 10;
  }

  // 2. Last chapter truncation detection
  if (chapters.length >= 3) {
    const avgWordCount = chapters.reduce((s, c) => s + c.wordCount, 0) / chapters.length;
    const lastChapter = chapters[chapters.length - 1];
    if (lastChapter.wordCount < avgWordCount * 0.3 && lastChapter.wordCount < 200) {
      issues.push(`Last chapter may be truncated: ${lastChapter.wordCount} words (avg: ${Math.round(avgWordCount)})`);
      score -= 10;
    }
  }

  // 3. Numbered chapter sequence check
  function extractChapterNumber(title: string): number | null {
    // Arabic: "Chapter 3", "Ch. 5"
    const arabic = title.match(/\bchapter\s+(\d+)\b/i) || title.match(/\bch\.?\s+(\d+)\b/i);
    if (arabic) return parseInt(arabic[1], 10);
    // Roman numerals up to XX
    const romanMap: Record<string, number> = {
      I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8,
      IX: 9, X: 10, XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15,
      XVI: 16, XVII: 17, XVIII: 18, XIX: 19, XX: 20,
    };
    const roman = title.match(/\bchapter\s+(X{0,2}(?:IX|IV|V?I{0,3}))\b/i);
    if (roman) return romanMap[roman[1].toUpperCase()] ?? null;
    return null;
  }
  const numberedChapters = chapters
    .map(c => extractChapterNumber(c.title))
    .filter((n): n is number => n !== null);
  if (numberedChapters.length >= 3) {
    const sorted = [...numberedChapters].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > 1) gaps.push(sorted[i - 1] + 1);
    }
    if (gaps.length > 0) {
      issues.push(`Chapter sequence gaps detected (missing: ${gaps.join(', ')})`);
      score -= 5;
    }
  }

  score = Math.max(0, Math.min(100, score));

  return { score, issues, pass: score >= 60 };
}
