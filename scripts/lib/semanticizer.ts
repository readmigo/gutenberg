/**
 * Semantic HTML enhancement module (Gap 3.2).
 *
 * Adds semantic markup to improve accessibility and reading app rendering:
 * - <abbr data-epub-type="z3998:name-title"> for honorifics and title abbreviations
 * - <span data-epub-type="z3998:roman"> for Roman numerals in chapter/section contexts
 * - <section data-epub-type="chapter"> wrapping for chapter structure
 * - <span data-epub-type="z3998:unit"> for measurement units with numeric values
 * - Heading level normalization (h1→h2, h2→h3 etc.)
 * - Verse block detection for poetry/verse content
 *
 * Operates on HTML strings, transforming only text nodes (not tag attributes).
 * All transforms are additive (wrapping), zero risk of content loss.
 */

// Honorifics and title abbreviations to wrap in <abbr>
const NAME_TITLE_ABBRS = [
  'Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Prof', 'Rev', 'St', 'Jr', 'Sr',
  'Capt', 'Col', 'Gen', 'Sgt', 'Cpl', 'Lt', 'Maj', 'Adm', 'Cmdr',
  'Supt', 'Insp', 'Gov', 'Pres', 'Sen', 'Rep',
  'Esq', 'Messrs', 'Mme', 'Mlle',
];

// Regex: match abbreviation followed by a period (word boundary ensures no partial match)
const ABBR_RE = new RegExp(
  `\\b(${NAME_TITLE_ABBRS.join('|')})\\.`,
  'g',
);

// Context markers that indicate a Roman numeral follows (chapter/act/scene)
const ROMAN_CONTEXT_RE = new RegExp(
  '\\b(Chapter|Act|Scene|Part|Book|Volume|Vol|Canto|Section|Article)\\s+' +
  '(X{0,3}(?:IX|IV|V?I{1,3})|X{1,3}|XL|L(?:X{0,3})|(?:XC|C)?[MDCLXVI]+)\\b',
  'gi',
);

// ─── Measurement Units ──────────────────────────────────────────────────────

// Imperial and common historical units found in Victorian literature
const MEASUREMENT_UNITS = [
  // Distance
  'miles?', 'yards?', 'feet', 'foot', 'inches?', 'leagues?', 'furlongs?',
  'fathoms?', 'rods?', 'chains?',
  // Weight
  'pounds?', 'lbs?\\.?', 'ounces?', 'oz\\.?', 'stones?', 'tons?',
  'hundredweight', 'cwt\\.?', 'grains?',
  // Volume
  'gallons?', 'quarts?', 'pints?', 'bushels?', 'barrels?', 'hogsheads?',
  'firkins?', 'gills?',
  // Currency
  'shillings?', 'pence', 'guineas?', 'crowns?', 'florins?', 'sovereigns?',
  // Area
  'acres?',
  // Speed / nautical
  'knots?',
  // Abbreviated
  'ft\\.?', 'in\\.?', 'yd\\.?', 'mi\\.?', 'mph',
];

// Pattern: number (with optional commas/decimals) + space + unit
const MEASUREMENT_RE = new RegExp(
  `(\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?)\\s+(${MEASUREMENT_UNITS.join('|')})\\b`,
  'gi',
);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Split HTML into text/tag segments to only modify text nodes.
 */
function splitHtmlSegments(html: string): { text: string; isTag: boolean }[] {
  const segments: { text: string; isTag: boolean }[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) { segments.push({ text: html.slice(i), isTag: false }); break; }
      segments.push({ text: html.slice(i, end + 1), isTag: true });
      i = end + 1;
    } else {
      const next = html.indexOf('<', i);
      if (next === -1) { segments.push({ text: html.slice(i), isTag: false }); break; }
      segments.push({ text: html.slice(i, next), isTag: false });
      i = next;
    }
  }
  return segments;
}

function transformTextNodes(html: string, fn: (text: string) => string): string {
  return splitHtmlSegments(html)
    .map(seg => (seg.isTag ? seg.text : fn(seg.text)))
    .join('');
}

// ─── Phase 1 Functions ──────────────────────────────────────────────────────

/**
 * Wrap known title abbreviations in <abbr> tags.
 * Must run AFTER typographer (NBSP already in place).
 */
function wrapAbbreviations(html: string): string {
  return transformTextNodes(html, text =>
    text.replace(ABBR_RE, '<abbr data-epub-type="z3998:name-title">$1.</abbr>'),
  );
}

/**
 * Wrap Roman numerals that follow chapter/section context words.
 * Conservative: only marks numerals after explicit context markers to avoid
 * false positives on pronouns (I) and common words (IV, VI as proper names).
 */
function wrapContextualRomanNumerals(html: string): string {
  return transformTextNodes(html, text =>
    text.replace(
      ROMAN_CONTEXT_RE,
      (_, contextWord: string, numeral: string) =>
        `${contextWord} <span data-epub-type="z3998:roman">${numeral}</span>`,
    ),
  );
}

/**
 * Wrap chapter HTML in a <section> element with chapter semantic type.
 * Only wraps if the content is not already inside a <section> tag.
 */
function wrapChapterSection(html: string): string {
  const trimmed = html.trim();
  if (trimmed.startsWith('<section')) return html;
  return `<section data-epub-type="chapter">\n${html}\n</section>`;
}

// ─── Phase 2 Functions ──────────────────────────────────────────────────────

/**
 * Mark measurement units with numeric values.
 * Only matches digit + unit patterns to avoid false positives like "stone wall".
 */
function markMeasurementUnits(html: string): string {
  return transformTextNodes(html, text =>
    text.replace(
      MEASUREMENT_RE,
      (match: string) => `<span data-epub-type="z3998:unit">${match}</span>`,
    ),
  );
}

/**
 * Normalize heading levels within a chapter.
 * PG EPUBs often use h1 for chapter headings; we normalize so the highest
 * level used becomes h2 (since h1 is reserved for the book title in metadata).
 * If chapter already starts at h2 or lower, no change is made.
 */
function normalizeHeadingLevels(html: string): string {
  const headingLevels = new Set<number>();
  const headingRe = /<h([1-6])\b/gi;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null) {
    headingLevels.add(parseInt(m[1], 10));
  }

  if (headingLevels.size === 0) return html;

  const minLevel = Math.min(...headingLevels);
  if (minLevel >= 2) return html;

  const shift = 2 - minLevel;

  return html.replace(
    /<(\/?)h([1-6])(\b[^>]*>)/gi,
    (_, slash: string, level: string, rest: string) => {
      const newLevel = Math.min(parseInt(level, 10) + shift, 6);
      return `<${slash}h${newLevel}${rest}`;
    },
  );
}

/**
 * Detect and mark verse/poetry blocks.
 *
 * Strategy (conservative):
 * 1. Elements with class containing "verse", "poem", or "stanza" get epub-type added
 * 2. <blockquote> elements containing 4+ <br/> with short average line length -> verse
 */
function detectVerseBlocks(html: string): string {
  let result = html;

  // Strategy 1: Add epub-type to elements with verse/poem/stanza class
  result = result.replace(
    /<(blockquote|div|p|pre)(\s[^>]*?)class="([^"]*\b(?:verse|poem|stanza)\b[^"]*)"([^>]*?)>/gi,
    (match: string, tag: string, pre: string, cls: string, post: string) => {
      if (/data-epub-type/.test(match)) return match;
      return `<${tag}${pre}class="${cls}" data-epub-type="z3998:verse"${post}>`;
    },
  );

  // Strategy 2: <blockquote> with many <br/> and short lines -> verse candidate
  result = result.replace(
    /<blockquote(\b[^>]*)>([\s\S]*?)<\/blockquote>/gi,
    (match: string, attrs: string, content: string) => {
      if (/data-epub-type/.test(attrs)) return match;
      const brCount = (content.match(/<br\s*\/?>/gi) || []).length;
      if (brCount < 3) return match;
      const lines = content.split(/<br\s*\/?>/i).map(l => l.replace(/<[^>]+>/g, '').trim());
      const nonEmptyLines = lines.filter(l => l.length > 0);
      if (nonEmptyLines.length < 4) return match;
      const avgLen = nonEmptyLines.reduce((s, l) => s + l.length, 0) / nonEmptyLines.length;
      if (avgLen < 60) {
        return `<blockquote${attrs} data-epub-type="z3998:verse">${content}</blockquote>`;
      }
      return match;
    },
  );

  return result;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Main entry point: apply semantic HTML enhancements.
 *
 * Order of operations:
 * 1. Chapter <section> wrapping (full HTML)
 * 2. Heading level normalization (full HTML)
 * 3. Verse block detection (full HTML)
 * 4. Contextual Roman numeral wrapping (text nodes only, context-aware)
 * 5. Abbreviation <abbr> wrapping (text nodes only)
 * 6. Measurement unit marking (text nodes only)
 */
export function semanticize(html: string): string {
  if (!html) return html;
  let result = wrapChapterSection(html);
  result = normalizeHeadingLevels(result);
  result = detectVerseBlocks(result);
  result = wrapContextualRomanNumerals(result);
  result = wrapAbbreviations(result);
  result = markMeasurementUnits(result);
  return result;
}
