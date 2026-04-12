export interface DetectedChapter {
  index: number;   // position in the HTML content
  title: string;   // extracted title text
  pattern: string; // which pattern matched
}

// ─── Pattern registry ────────────────────────────────────────────────────────

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: 'numbered',
    re: /第[一二三四五六七八九十百千\d]+[回章节篇卷集部]/,
  },
  {
    name: 'volume',
    re: /卷[一二三四五六七八九十百千\d上中下]+/,
  },
  {
    name: 'section',
    re: /篇[一二三四五六七八九十百千\d]+/,
  },
  {
    name: 'part',
    re: /[上中下]篇/,
  },
  {
    name: 'auxiliary',
    re: /序言?|引[言子]|前言|后记|跋|附录|楔子|引首|尾声/,
  },
  {
    name: 'cjk-numbered',
    re: /[一二三四五六七八九十]+[、，]/,
  },
  {
    name: 'arabic-numbered',
    re: /\d+[\.、]/,
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Remove all HTML tags and decode common entities. */
export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Returns the pattern name that matched `text`, or `null` if none.
 * Patterns are tested in priority order.
 */
export function matchChapterPattern(text: string): string | null {
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Detect Chinese chapter titles in an HTML string.
 *
 * Strategy:
 * 1. Scan every <h1>-<h6> element; collect those whose text matches a pattern.
 * 2. If no heading-based chapters were found, fall back to <p> elements whose
 *    stripped text is 1-50 characters long and matches a pattern.
 *
 * Returns chapters in document order with their byte offset (index) into the
 * original HTML string.
 */
export function detectChapters(html: string): DetectedChapter[] {
  const results: DetectedChapter[] = [];

  // Pass 1: headings
  const headingRe = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let m: RegExpExecArray | null;

  while ((m = headingRe.exec(html)) !== null) {
    const text = stripTags(m[1]);
    const pattern = matchChapterPattern(text);
    if (pattern) {
      results.push({ index: m.index, title: text, pattern });
    }
  }

  if (results.length > 0) return results;

  // Pass 2: short <p> fallback
  const paraRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;

  while ((m = paraRe.exec(html)) !== null) {
    const text = stripTags(m[1]);
    if (text.length < 1 || text.length > 50) continue;
    const pattern = matchChapterPattern(text);
    if (pattern) {
      results.push({ index: m.index, title: text, pattern });
    }
  }

  return results;
}
