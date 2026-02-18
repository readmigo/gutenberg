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

  score = Math.max(0, Math.min(100, score));

  return { score, issues, pass: score >= 60 };
}
