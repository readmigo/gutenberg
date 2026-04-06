import { createHash } from 'crypto';

export interface QualityResult {
  score: number; // 0-100
  issues: string[];
  pass: boolean; // score >= 60
  tier: 'auto_approved' | 'needs_review' | 'rejected'; // ≥80 / 60-79 / <60
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

// Detect residual Gutenberg boilerplate that wasn't cleaned
function hasResidualBoilerplate(html: string): boolean {
  const patterns = [
    /Project Gutenberg/i,
    /gutenberg\.org/i,
    /\*\*\* START OF/i,
    /\*\*\* END OF/i,
    /This eBook is for the use of anyone/i,
    /SMALL PRINT!/i,
  ];
  return patterns.some((p) => p.test(html));
}

// Detect repeated paragraphs (content duplication)
function countRepeatedParagraphs(html: string): number {
  const paragraphs = html
    .match(/<p[^>]*>([\s\S]*?)<\/p>/gi)
    ?.map(p => p.replace(/<[^>]+>/g, '').trim().toLowerCase())
    .filter(p => p.length > 50) || [];

  const seen = new Map<string, number>();
  let duplicates = 0;
  for (const p of paragraphs) {
    const count = (seen.get(p) || 0) + 1;
    seen.set(p, count);
    if (count === 2) duplicates++; // count each duplicate once
  }
  return duplicates;
}

// Estimate non-English content ratio
function nonEnglishRatio(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return 0;

  // Simple heuristic: count words with non-ASCII-letter characters
  const nonEnglish = words.filter(w => /[^\x00-\x7F]/.test(w.replace(/[\u2018\u2019\u201C\u201D\u2014\u2013\u2026\u00A0\u200A\u2060]/g, '')));
  return nonEnglish.length / words.length;
}

// Strip HTML for text analysis
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function checkBookQuality(book: BookData, chapters: ChapterData[]): QualityResult {
  const issues: string[] = [];
  let score = 100;

  // === Original checks ===

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

  // Upper bound sanity check. War and Peace is ~587k words; anything beyond
  // 1M is almost certainly the result of parser-level content duplication.
  if (book.wordCount > 1_000_000) {
    issues.push(`Impossible word count: ${book.wordCount} (parser duplication?)`);
    score = 0;
  } else if (book.wordCount > 500_000) {
    issues.push(`Implausibly high word count: ${book.wordCount}`);
    score -= 50;
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
    const arabic = title.match(/\bchapter\s+(\d+)\b/i) || title.match(/\bch\.?\s+(\d+)\b/i);
    if (arabic) return parseInt(arabic[1], 10);
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

  // === New enhanced checks ===

  // 4. Residual Gutenberg boilerplate in chapters
  let boilerplateChapters = 0;
  for (const ch of chapters) {
    if (hasResidualBoilerplate(ch.htmlContent)) {
      boilerplateChapters++;
    }
  }
  if (boilerplateChapters > 0 && chapters.length > 0) {
    const ratio = boilerplateChapters / chapters.length;
    issues.push(
      `Gutenberg boilerplate residue in ${boilerplateChapters}/${chapters.length} chapter(s) (${Math.round(ratio * 100)}%)`,
    );
    if (ratio >= 0.5) {
      // More than half the chapters contain PG boilerplate — this is a
      // parser/cleaner failure, force the book below the rejected threshold.
      score = Math.min(score, 30);
    } else {
      // Scale linearly by affected fraction, up to a 40-point penalty.
      score -= Math.round(ratio * 40);
    }
  }

  // 5. Repeated paragraphs (content duplication)
  const allHtml = chapters.map(c => c.htmlContent).join('\n');
  const duplicateParagraphs = countRepeatedParagraphs(allHtml);
  if (duplicateParagraphs > 3) {
    issues.push(`${duplicateParagraphs} duplicated paragraphs detected`);
    score -= Math.min(15, duplicateParagraphs * 3);
  }

  // 6. Non-English content ratio (for English books)
  const sampleText = stripHtml(
    chapters.slice(0, Math.min(3, chapters.length)).map(c => c.htmlContent).join(' '),
  );
  const nonEngRatio = nonEnglishRatio(sampleText);
  if (nonEngRatio > 0.3) {
    issues.push(`High non-English content ratio: ${Math.round(nonEngRatio * 100)}%`);
    score -= 20;
  } else if (nonEngRatio > 0.15) {
    issues.push(`Moderate non-English content: ${Math.round(nonEngRatio * 100)}%`);
    score -= 10;
  }

  // 7. Chapter length variance (detect merging errors)
  if (chapters.length >= 4) {
    const wordCounts = chapters.map(c => c.wordCount).filter(w => w > 0);
    if (wordCounts.length >= 4) {
      const mean = wordCounts.reduce((s, w) => s + w, 0) / wordCounts.length;
      const variance = wordCounts.reduce((s, w) => s + (w - mean) ** 2, 0) / wordCounts.length;
      const cv = Math.sqrt(variance) / mean; // coefficient of variation
      if (cv > 2.0) {
        issues.push(`Extreme chapter length variation (CV: ${cv.toFixed(1)}) - possible merge error`);
        score -= 10;
      } else if (cv > 1.5) {
        issues.push(`High chapter length variation (CV: ${cv.toFixed(1)})`);
        score -= 5;
      }
    }
  }

  // 8. Chapter content duplication check. The cheapest and most diagnostic
  // guard against upstream parser bugs that copy the same file content into
  // multiple chapter records. Any duplicate group is fatal — the book is
  // unreadable regardless of what other checks say.
  if (chapters.length > 1) {
    const hashToChapters = new Map<string, number[]>();
    for (let i = 0; i < chapters.length; i++) {
      const text = stripHtml(chapters[i].htmlContent).toLowerCase().replace(/\s+/g, '');
      if (text.length < 100) continue;
      const hash = createHash('sha1').update(text).digest('hex');
      if (!hashToChapters.has(hash)) hashToChapters.set(hash, []);
      hashToChapters.get(hash)!.push(i + 1);
    }
    const duplicateGroups = [...hashToChapters.values()].filter((g) => g.length > 1);
    if (duplicateGroups.length > 0) {
      const duplicatedCount = duplicateGroups.reduce((s, g) => s + g.length, 0);
      const sample = duplicateGroups
        .slice(0, 3)
        .map((g) => `[${g.join(',')}]`)
        .join(' ');
      issues.push(
        `Chapter content duplication: ${duplicatedCount} chapters share identical content ${sample}`,
      );
      score = 0;
    }
  }

  score = Math.max(0, Math.min(100, score));

  // Determine tier based on score
  let tier: QualityResult['tier'];
  if (score >= 80) {
    tier = 'auto_approved';
  } else if (score >= 60) {
    tier = 'needs_review';
  } else {
    tier = 'rejected';
  }

  return { score, issues, pass: score >= 60, tier };
}
