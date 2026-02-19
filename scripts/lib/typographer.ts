/**
 * Typography normalization module.
 *
 * Converts plain/PG-style text to SE-quality typography:
 * - Smart (curly) quotes
 * - Em-dash with word joiner (U+2060 + U+2014)
 * - Two-em dash (U+2E3A) for partially censored names
 * - Three-em dash (U+2E3B) for fully omitted names
 * - En-dash with word joiners (U+2060 + U+2013 + U+2060) for number ranges
 * - Ellipsis with word joiner (U+2060 + U+2026)
 * - Non-breaking space after abbreviations
 * - Hair space (U+200A) between nested quotation marks
 * - Section break normalization
 *
 * Operates on HTML strings, transforming only text nodes (not tag attributes).
 */

// Unicode constants
const LEFT_DOUBLE_QUOTE = '\u201C';
const RIGHT_DOUBLE_QUOTE = '\u201D';
const LEFT_SINGLE_QUOTE = '\u2018';
const RIGHT_SINGLE_QUOTE = '\u2019';
const WORD_JOINER = '\u2060';
const EM_DASH = '\u2014';
const EN_DASH = '\u2013';
const ELLIPSIS = '\u2026';
const NBSP = '\u00A0';
const HAIR_SPACE = '\u200A';
const TWO_EM_DASH = '\u2E3A';
const THREE_EM_DASH = '\u2E3B';

const WJ_EM_DASH = WORD_JOINER + EM_DASH;
const WJ_ELLIPSIS = WORD_JOINER + ELLIPSIS;

// Abbreviations that should have NBSP after them
const ABBREVIATIONS = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'St', 'Jr', 'Sr',
  'Prof', 'Rev', 'Vol', 'No', 'vs', 'etc',
];
const ABBR_PATTERN = new RegExp(
  `\\b(${ABBREVIATIONS.join('|')})\\.( )(?=[A-Za-z])`,
  'g',
);

// Section break patterns (text dividers like * * *, ***, etc.)
const SECTION_BREAK_RE = /^<p[^>]*>\s*(?:\*\s*){2,}\s*<\/p>$/gim;

/**
 * Split HTML into text segments and tag segments so we only
 * transform text content, never tag names or attribute values.
 */
function splitHtmlSegments(html: string): { text: string; isTag: boolean }[] {
  const segments: { text: string; isTag: boolean }[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        // Malformed tag – treat rest as text
        segments.push({ text: html.slice(i), isTag: false });
        break;
      }
      segments.push({ text: html.slice(i, end + 1), isTag: true });
      i = end + 1;
    } else {
      const next = html.indexOf('<', i);
      if (next === -1) {
        segments.push({ text: html.slice(i), isTag: false });
        break;
      }
      segments.push({ text: html.slice(i, next), isTag: false });
      i = next;
    }
  }
  return segments;
}

/**
 * Apply a transformation function only to text segments of an HTML string.
 */
function transformTextNodes(html: string, fn: (text: string) => string): string {
  const segments = splitHtmlSegments(html);
  return segments.map(seg => (seg.isTag ? seg.text : fn(seg.text))).join('');
}

// ─── Smart Quotes ────────────────────────────────────────────────────────────

/**
 * Convert HTML entities for quotes to their literal characters first.
 */
function decodeQuoteEntities(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
}

/**
 * Convert straight quotes to typographic curly quotes in a text node.
 *
 * Algorithm:
 * 1. Convert obvious contractions/apostrophes to right single quote
 * 2. Convert opening double quotes
 * 3. Convert closing double quotes
 * 4. Convert opening single quotes
 * 5. Convert closing single quotes
 * 6. Handle remaining ambiguous quotes
 */
function smartQuotes(text: string): string {
  // Skip if already has curly quotes (don't double-convert)
  // but still process straight quotes that may remain
  let s = decodeQuoteEntities(text);

  // --- Pass 1: Contractions / apostrophes → right single quote ---
  // Common contractions: n't, 's, 'd, 'll, 're, 've, 'm
  s = s.replace(/(\w)'(t|s|d|ll|re|ve|m)\b/gi, `$1${RIGHT_SINGLE_QUOTE}$2`);
  // Special contractions at word start: 'tis, 'twas, 'em, 'n', 'cause
  s = s.replace(/\b'(tis|twas|em|n|cause)\b/gi, `${RIGHT_SINGLE_QUOTE}$1`);
  // Possessive after s: dogs' bones
  s = s.replace(/(\w)s'(\s|$)/g, `$1s${RIGHT_SINGLE_QUOTE}$2`);
  // o'clock
  s = s.replace(/\bo'clock/gi, `o${RIGHT_SINGLE_QUOTE}clock`);
  // Decades: '90s, '20s
  s = s.replace(/'(\d\ds?\b)/g, `${RIGHT_SINGLE_QUOTE}$1`);

  // --- Pass 2: Double quotes ---
  // Opening double quote: after whitespace, start of string, or after certain punctuation
  s = s.replace(/(^|[\s(\[{])"/g, `$1${LEFT_DOUBLE_QUOTE}`);
  // Closing double quote: before whitespace, punctuation, end of string
  s = s.replace(/"([\s.,;:!?\)\]}\-—–]|$)/g, `${RIGHT_DOUBLE_QUOTE}$1`);
  // Remaining straight double quotes: use heuristic based on position
  // If preceded by a letter/punctuation it's closing, otherwise opening
  s = s.replace(/(\w)"/g, `$1${RIGHT_DOUBLE_QUOTE}`);
  s = s.replace(/"(\w)/g, `${LEFT_DOUBLE_QUOTE}$1`);
  // Any leftover double quotes
  s = s.replace(/"/g, RIGHT_DOUBLE_QUOTE);

  // --- Pass 3: Single quotes ---
  // Opening single quote: after whitespace, start of string, left double quote
  s = s.replace(/(^|[\s(\[{]|[\u201C])'(?=\w)/g, `$1${LEFT_SINGLE_QUOTE}`);
  // Closing single quote: before whitespace, punctuation, end of string
  // (Only target straight single quotes that remain)
  s = s.replace(/'([\s.,;:!?\)\]}\-—–\u201D]|$)/g, `${RIGHT_SINGLE_QUOTE}$1`);
  // Any leftover single straight quotes → right single (apostrophe is more common than opening)
  s = s.replace(/'/g, RIGHT_SINGLE_QUOTE);

  return s;
}

// ─── Em-Dash ─────────────────────────────────────────────────────────────────

/**
 * Normalize dashes to Word Joiner + Em Dash pattern.
 */
function normalizeEmDashes(text: string): string {
  let s = text;
  // Spaced or unspaced double-hyphen → WJ + em-dash
  s = s.replace(/ ?-- ?/g, WJ_EM_DASH);
  // Existing em-dash (with or without spaces, without preceding word joiner) → WJ + em-dash
  // First remove any spaces around existing em-dashes
  s = s.replace(/ ?\u2014 ?/g, EM_DASH);
  // Now ensure word joiner before every em-dash that doesn't already have one
  s = s.replace(/(?<!\u2060)\u2014/g, WJ_EM_DASH);
  return s;
}

// ─── Multi-Em-Dash (Two-em / Three-em) ──────────────────────────────────────

/**
 * Convert sequences of 3+ em-dashes to three-em dash (U+2E3B),
 * and sequences of 2 em-dashes to two-em dash (U+2E3A).
 * Three-em dash: fully omitted names/words. Two-em dash: partially censored names.
 * Must run AFTER normalizeEmDashes() so em-dashes are already normalized.
 */
function normalizeMultiEmDashes(text: string): string {
  let s = text;
  // Three or more consecutive em-dashes (with optional word joiners) → three-em dash
  s = s.replace(/(?:\u2060?\u2014){3,}/g, THREE_EM_DASH);
  // Two consecutive em-dashes (with optional word joiners) → two-em dash
  s = s.replace(/(?:\u2060?\u2014){2}/g, TWO_EM_DASH);
  return s;
}

// ─── En-Dash (Number Ranges) ────────────────────────────────────────────────

/**
 * Convert hyphens between digits to en-dash with word joiners.
 * E.g., "pages 10-20" → "pages 10⁠–⁠20"
 * Only matches digit-hyphen-digit patterns (not negative numbers or compound words).
 */
function normalizeEnDashes(text: string): string {
  return text.replace(/(\d)\s*-\s*(\d)/g, `$1${WORD_JOINER}${EN_DASH}${WORD_JOINER}$2`);
}

// ─── Ellipsis ────────────────────────────────────────────────────────────────

/**
 * Normalize ellipsis to Word Joiner + Ellipsis character.
 */
function normalizeEllipsis(text: string): string {
  let s = text;
  // Spaced dots: ". . ." → WJ + ellipsis
  s = s.replace(/\. \. \./g, WJ_ELLIPSIS);
  // Three dots → WJ + ellipsis
  s = s.replace(/\.\.\./g, WJ_ELLIPSIS);
  // Existing ellipsis character without word joiner → add WJ
  s = s.replace(/(?<!\u2060)\u2026/g, WJ_ELLIPSIS);
  return s;
}

// ─── Non-Breaking Space After Abbreviations ──────────────────────────────────

/**
 * Replace regular space after abbreviations with NBSP.
 */
function nbspAfterAbbreviations(text: string): string {
  return text.replace(ABBR_PATTERN, `$1.${NBSP}`);
}

// ─── Hair Space (Nested Quotes) ─────────────────────────────────────────────

/**
 * Insert hair space between adjacent opening/closing quote pairs
 * to improve visual separation of nested quotation marks.
 * E.g., "' → " ' (with hair space) and '" → ' " (with hair space).
 */
function insertHairSpaces(text: string): string {
  let s = text;
  // Left double + left single (opening nested): "' → " '
  s = s.replace(
    new RegExp(`${LEFT_DOUBLE_QUOTE}${LEFT_SINGLE_QUOTE}`, 'g'),
    `${LEFT_DOUBLE_QUOTE}${HAIR_SPACE}${LEFT_SINGLE_QUOTE}`,
  );
  // Right single + right double (closing nested): '" → ' "
  s = s.replace(
    new RegExp(`${RIGHT_SINGLE_QUOTE}${RIGHT_DOUBLE_QUOTE}`, 'g'),
    `${RIGHT_SINGLE_QUOTE}${HAIR_SPACE}${RIGHT_DOUBLE_QUOTE}`,
  );
  return s;
}

// ─── Section Breaks ──────────────────────────────────────────────────────────

/**
 * Convert text dividers like * * * to <hr/>.
 * This operates on the full HTML (not just text nodes).
 */
function normalizeSectionBreaks(html: string): string {
  return html.replace(SECTION_BREAK_RE, '<hr/>');
}

// ─── Combined Transform ──────────────────────────────────────────────────────

/**
 * Apply all text-node typography transformations in sequence.
 */
function typographizeTextNode(text: string): string {
  let s = text;
  s = smartQuotes(s);
  s = normalizeEmDashes(s);
  s = normalizeMultiEmDashes(s);
  s = normalizeEnDashes(s);
  s = normalizeEllipsis(s);
  s = nbspAfterAbbreviations(s);
  s = insertHairSpaces(s);
  return s;
}

/**
 * Main entry point: apply SE-quality typography normalization to an HTML string.
 *
 * Transforms text content only (not HTML tags or attributes).
 * Order of operations:
 * 1. Section break normalization (full HTML)
 * 2. Smart quotes (text nodes)
 * 3. Em-dash normalization (text nodes)
 * 4. Multi-em-dash normalization: two-em (U+2E3A) / three-em (U+2E3B)
 * 5. En-dash for number ranges (text nodes)
 * 6. Ellipsis normalization (text nodes)
 * 7. NBSP after abbreviations (text nodes)
 * 8. Hair space between nested quotes (text nodes)
 */
export function typographize(html: string): string {
  if (!html) return html;

  // Step 1: section breaks (operates on full HTML since it replaces whole <p> tags)
  let result = normalizeSectionBreaks(html);

  // Steps 2-5: text-node-only transformations
  result = transformTextNodes(result, typographizeTextNode);

  return result;
}
