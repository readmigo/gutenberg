// Spelling modernizer based on Standard Ebooks editorial conventions.
// Applies high-confidence spelling corrections, compound word close-ups,
// and punctuation fixes to HTML content (text nodes only).

// Dictionary 1: Archaic spelling corrections (always apply)
const spellingCorrections: [RegExp, string][] = [
  [/\becstacy\b/gi, 'ecstasy'],
  [/\bdumbfoundered\b/gi, 'dumbfounded'],
  [/\bvillanous\b/gi, 'villainous'],
  [/\bmantlepiece\b/gi, 'mantelpiece'],
  [/\balchymists\b/gi, 'alchemists'],
  [/\bbarbacued\b/gi, 'barbecued'],
  [/\bmaccaroni\b/gi, 'macaroni'],
  [/\binuendoes\b/gi, 'innuendoes'],
  [/\bmattrass\b/gi, 'mattress'],
  [/\bpigmy\b/gi, 'pygmy'],
  [/\bribands\b/gi, 'ribbons'],
  [/\bslipt\b/gi, 'slipped'],
  [/\bappal\b/g, 'appall'],
  [/\bappals\b/g, 'appalls'],
  [/\binclose\b/gi, 'enclose'],
  [/\binclosure\b/gi, 'enclosure'],
  [/\bVampyre\b/g, 'Vampire'],
  [/\bblest\b/gi, 'blessed'],
  [/\bPandaemonium\b/g, 'Pandemonium'],
  [/\bWerter\b/g, 'Werther'],
];

// Dictionary 2: Compound word modernization (close-ups)
const compoundWords: [RegExp, string][] = [
  // Two-word -> one word (flexible whitespace)
  [/\bhalf\s+way\b/gi, 'halfway'],
  [/\bfor\s+evermore\b/gi, 'forevermore'],
  [/\bmain\s+land\b/gi, 'mainland'],
  [/\bmean\s+time\b/gi, 'meantime'],
  [/\bsafe\s+keeping\b/gi, 'safekeeping'],
  [/\blive\s+stock\b/gi, 'livestock'],
  [/\bhigh\s+lights\b/gi, 'highlights'],
  [/\bup\s+hill\b/gi, 'uphill'],
  [/\bdown\s+hill\b/gi, 'downhill'],
  // Hyphenated -> one word
  [/\btrap-doors\b/gi, 'trapdoors'],
  [/\btrap-door\b/gi, 'trapdoor'],
  [/\bmountain-tops\b/gi, 'mountaintops'],
  [/\bmountain-top\b/gi, 'mountaintop'],
  [/\binn-yard\b/gi, 'innyard'],
  [/\bbell-pull\b/gi, 'bellpull'],
  [/\bcherry-wood\b/gi, 'cherrywood'],
  [/\bplain-clothes\b/gi, 'plainclothes'],
  [/\bpost-boy\b/gi, 'postboy'],
  [/\bcat-like\b/gi, 'catlike'],
  [/\bblood-red\b/gi, 'bloodred'],
  [/\bsuch-like\b/gi, 'suchlike'],
  [/\bre-entering\b/gi, 'reentering'],
  [/\bre-entered\b/gi, 'reentered'],
  [/\bre-enter\b/gi, 'reenter'],
  // Two-word close-ups
  [/\bhuman\s+kind\b/gi, 'humankind'],
  [/\bunder\s+weigh\b/gi, 'underway'],
  // Hyphenated -> two words
  [/\bwedding-night\b/gi, 'wedding night'],
  // Solid -> hyphenated (longer forms first to avoid partial replacement)
  [/\bhardheartedness\b/gi, 'hard-heartedness'],
  [/\bhardhearted\b/gi, 'hard-hearted'],
  [/\bbarelegged\b/gi, 'bare-legged'],
  [/\bparticolou?red\b/gi, 'parti-coloured'],
  [/\bparticolor\b/gi, 'parti-color'],
];

// Dictionary 3: Punctuation fixes (always apply)
const punctuationFixes: [RegExp, string][] = [
  [/\bher's\b/g, 'hers'],
  [/\bby-and-bye\b/gi, 'by-and-by'],
  [/\bby-the-bye\b/gi, 'by the by'],
];

const allReplacements: [RegExp, string][] = [
  ...spellingCorrections,
  ...compoundWords,
  ...punctuationFixes,
];

/**
 * Apply spelling modernization to HTML content.
 * Only replaces text outside of HTML tags to avoid corrupting attributes.
 */
export function modernizeSpelling(html: string): string {
  // Split HTML into text segments and tag segments, apply replacements only to text
  return html.replace(
    /([^<]+)|(<[^>]*>)/g,
    (match, textPart: string | undefined) => {
      if (!textPart) return match; // It's an HTML tag, leave it alone
      let result = textPart;
      for (const [pattern, replacement] of allReplacements) {
        result = result.replace(pattern, replacement);
      }
      return result;
    },
  );
}
