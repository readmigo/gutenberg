/**
 * Semantic HTML enhancement module (Gap 3.2).
 *
 * Adds semantic markup to improve accessibility and reading app rendering:
 * - <abbr data-epub-type="z3998:name-title"> for honorifics and title abbreviations
 * - <span data-epub-type="z3998:roman"> for Roman numerals in chapter/section contexts
 *
 * Operates on HTML strings, transforming only text nodes (not tag attributes).
 * All transforms are additive (wrapping), zero risk of content loss.
 */

// Honorifics and title abbreviations to wrap in <abbr>
const NAME_TITLE_ABBRS = [
  'Mr', 'Mrs', 'Ms', 'Miss', 'Dr', 'Prof', 'Rev', 'St', 'Jr', 'Sr',
  'Capt', 'Col', 'Gen', 'Sgt', 'Cpl', 'Lt', 'Maj', 'Adm', 'Cmdr',
  'Supt', 'Insp', 'Gov', 'Pres', 'Sen', 'Rep',
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
 * Main entry point: apply semantic HTML enhancements.
 *
 * Order of operations:
 * 1. Contextual Roman numeral wrapping (text nodes only, context-aware)
 * 2. Abbreviation <abbr> wrapping (text nodes only)
 */
export function semanticize(html: string): string {
  if (!html) return html;
  let result = wrapContextualRomanNumerals(html);
  result = wrapAbbreviations(result);
  return result;
}
