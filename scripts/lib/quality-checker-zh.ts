import { createHash } from 'crypto';

export interface ZhQualityResult {
  score: number;  // 0-100
  issues: string[];
  pass: boolean;  // score >= 60
  tier: 'auto_approved' | 'needs_review' | 'rejected';
}

interface ZhBookData {
  title: string;
  chapterCount: number;
  wordCount: number;  // character count for Chinese
  hasCover: boolean;
}

interface ZhChapterData {
  title: string;
  wordCount: number;  // character count
  htmlContent: string;
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

export function checkZhBookQuality(book: ZhBookData, chapters: ZhChapterData[]): ZhQualityResult {
  const issues: string[] = [];
  let score = 100;

  // 1. Chapter count check
  if (chapters.length === 0) {
    issues.push('No chapters extracted');
    score -= 50;
  } else if (chapters.length < 2) {
    issues.push(`Very few chapters: ${chapters.length}`);
    score -= 15;
  }

  // 2. Character count check (Chinese-adjusted thresholds)
  if (book.wordCount > 2_000_000) {
    issues.push(`Impossible character count: ${book.wordCount} (parser duplication?)`);
    score = 0;
  } else if (book.wordCount < 500) {
    issues.push(`Very low character count: ${book.wordCount}`);
    score -= 30;
  } else if (book.wordCount < 2000) {
    issues.push(`Low character count: ${book.wordCount}`);
    score -= 10;
  }

  // 3. Empty chapters — threshold is 20 chars (not 50 words)
  const emptyChapters = chapters.filter((c) => c.wordCount < 20);
  if (emptyChapters.length > 0) {
    issues.push(`${emptyChapters.length} near-empty chapters (< 20 chars)`);
    score -= emptyChapters.length * 5;
  }

  // 4. Cover check
  if (!book.hasCover) {
    issues.push('No cover image');
    score -= 10;
  }

  // 5. CJK content ratio check
  // Strip HTML from first 3 chapters and check for sufficient CJK content.
  // A low CJK ratio indicates garbled or wrong-language content.
  const sampleText = stripHtml(
    chapters.slice(0, Math.min(3, chapters.length)).map(c => c.htmlContent).join(' '),
  );
  const nonWhitespace = sampleText.replace(/\s/g, '');
  if (nonWhitespace.length > 0) {
    const cjkChars = nonWhitespace.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
    const cjkRatio = (cjkChars?.length ?? 0) / nonWhitespace.length;
    if (cjkRatio < 0.3) {
      issues.push(`Low CJK content ratio: ${Math.round(cjkRatio * 100)}% (expected >= 30%)`);
      score -= 20;
    }
  }

  // 6. Mojibake / encoding check (all chapters)
  for (const ch of chapters) {
    if (hasMojibake(ch.htmlContent)) {
      issues.push(`Encoding issues detected in chapter: ${ch.title}`);
      score -= 15;
      break;
    }
  }

  // 7. Duplicate chapter content check (fatal — score = 0 on any duplicate)
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

  // 8. Chapter length variance (detect merging errors)
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

  // 9. Residual Gutenberg boilerplate in chapters
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
      score = Math.min(score, 30);
    } else {
      score -= Math.round(ratio * 40);
    }
  }

  score = Math.max(0, Math.min(100, score));

  // Determine tier
  let tier: ZhQualityResult['tier'];
  if (score >= 80) {
    tier = 'auto_approved';
  } else if (score >= 60) {
    tier = 'needs_review';
  } else {
    tier = 'rejected';
  }

  return { score, issues, pass: score >= 60, tier };
}
