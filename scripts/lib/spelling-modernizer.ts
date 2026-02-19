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

// Dictionary 6: Geographic and cultural name modernization
// Sourced from SE spelling.py + SE git diff analysis. ~93% automatable via static dict.
// Deliberately excludes "Lewis→Louis" (ambiguous with English name Lewis).
const geographicNames: [RegExp, string][] = [
  // Plural forms before singular to avoid partial match issues
  [/\bFeegeeans\b/gi, 'Fijians'],
  [/\bFeegees\b/gi, 'Fijis'],
  [/\bMoslems\b/gi, 'Muslims'],
  [/\bRoumanians\b/gi, 'Romanians'],
  [/\bRomanoffs\b/g, 'Romanovs'],
  [/\bHimmalehs\b/gi, 'Himalayas'],
  // Geographic names (from SE spelling.py)
  [/\bBarbadoes\b/gi, 'Barbados'],
  [/\bBehring\b/gi, 'Bering'],
  [/\bBuda-Pest\b/gi, 'Budapest'],
  [/\bBuenos Ayres\b/gi, 'Buenos Aires'],
  [/\bCracow\b/gi, 'Krakow'],
  [/\bEsthonian\b/gi, 'Estonian'],
  [/\bEsthonia\b/gi, 'Estonia'],
  [/\bGizeh\b/gi, 'Giza'],
  [/\bHamburgh\b/gi, 'Hamburg'],
  [/\bHaytian\b/gi, 'Haitian'],
  [/\bHayti\b/gi, 'Haiti'],
  [/\bKieff\b/gi, 'Kiev'],
  [/\bKief\b/gi, 'Kiev'],
  [/\bKeltic\b/gi, 'Celtic'],
  [/\bKelt\b/g, 'Celt'],
  [/\bLeipsic\b/gi, 'Leipzig'],
  [/\bMahommed\b/gi, 'Muhammad'],
  [/\bMahomet\b/gi, 'Muhammad'],
  [/\bMoslem\b/gi, 'Muslim'],
  [/\bPorto Rico\b/gi, 'Puerto Rico'],
  [/\bRoumanian\b/gi, 'Romanian'],
  [/\bRoumania\b/gi, 'Romania'],
  [/\bRomanoff\b/g, 'Romanov'],
  [/\bSoudan\b/gi, 'Sudan'],
  [/\bStrasburgh\b/gi, 'Strasbourg'],
  [/\bThibet\b/gi, 'Tibet'],
  [/\bTimbuctoo\b/gi, 'Timbuktu'],
  [/\bTokio\b/gi, 'Tokyo'],
  [/\bYeddo\b/gi, 'Edo'],
  [/\bJeddo\b/gi, 'Edo'],
  // From SE git diff of 10 books (Appendix B.3)
  [/\bAshantee\b/gi, 'Ashanti'],
  [/\bBelrive\b/g, 'Bellerive'],
  [/\bErromanggoans\b/gi, 'Erromangoans'],
  [/\bFeegee\b/gi, 'Fiji'],
  [/\bFegee\b/gi, 'Fiji'],
  [/\bFejee\b/gi, 'Fiji'],
  [/\bGallipagos\b/gi, 'Galapagos'],
  [/\bHimmalehan\b/gi, 'Himalayan'],
  [/\bHindostanee\b/gi, 'Hindustani'],
  [/\bServian\b/gi, 'Serbian'],
  [/\bStrasburgh\b/gi, 'Strasbourg'],
  [/\bsuttee\b/gi, 'sati'],
];

// Dictionary 4: Diacritical marks corrections (per B.4 in verification report)
const diacriticalFixes: [RegExp, string][] = [
  [/\ba\u00EBrial\b/gi, 'aerial'],   // aërial → aerial (diaeresis on ë)
  [/\bd\u00F4me\b/gi, 'dome'],        // dôme → dome (circumflex on ô)
  [/\bc\u00E6lestis\b/gi, 'caelestis'], // cælestis → caelestis (ae ligature)
  [/\bt\u00E6dium\b/gi, 'taedium'],   // tædium → taedium
  [/\bRom\u00E6\b/g, 'Romae'],        // Romæ → Romae
];

// Dictionary 5: Latin ligature expansion (Gap 3.5)
// Expands æ/œ ligatures to ae/oe in English-context words
const ligatureExpansions: [RegExp, string][] = [
  [/\u00C6(?=[a-z])/g, 'Ae'],  // Æ at word start followed by lowercase
  [/\u0152(?=[a-z])/g, 'Oe'],  // Œ at word start followed by lowercase
  [/\u00E6/g, 'ae'],             // æ → ae
  [/\u0153/g, 'oe'],             // œ → oe
];

const allReplacements: [RegExp, string][] = [
  ...spellingCorrections,
  ...compoundWords,
  ...punctuationFixes,
  ...geographicNames,
  ...diacriticalFixes,
  ...ligatureExpansions,
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
