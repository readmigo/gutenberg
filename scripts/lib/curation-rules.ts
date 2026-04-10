/**
 * Readmigo curation rules.
 *
 * The Gutenberg pipeline can technically extract any PG book, but a few text
 * categories do not currently render well in the Readmigo reader and are
 * therefore excluded from import. The exclusion happens in two places:
 *
 *   1. `pg-discover.ts` skips excluded books before queueing a process job,
 *      so they never enter the pipeline at all.
 *   2. `quality-checker.ts` re-checks at process time and downgrades any
 *      excluded book that slipped past discovery to `needs_review` so it
 *      cannot reach the `ready` state without a manual override.
 *
 * The excluded categories and their detection signals:
 *
 *   - Lyric poetry collections (subjects "Poetry", "Poems", title contains
 *     "Poems"/"Sonnets"/"Songs"/"Verses"). Epic narrative poems are exempted
 *     by an explicit allowlist (Iliad, Odyssey, Beowulf, etc.).
 *
 *   - Drama / plays (subjects "Drama", "Plays", "Tragedy", "Comedy"). The
 *     reader does not yet typeset stage directions and speech prefixes
 *     correctly so even Shakespeare and Wilde are out for now.
 *
 *   - Multi-translator compilations (title or description mentions
 *     "various translators" / "translated by various"). These are short
 *     story collections that splice prose from several translators and
 *     typically misalign on chapter boundaries.
 *
 *   - Translator's-preface-dominant books (detected after extraction:
 *     first chapter exceeds 30% of total words AND its title contains
 *     "Introduction"/"Preface"/"Translator"). These are PG editions where
 *     the apparatus crowds out the actual text.
 *
 *   - Academic / non-popular subjects (subjects contain "Philosophy",
 *     "Ethics", "Political science", "Literary criticism", "Theology",
 *     "Economics", etc.). Readmigo targets casual readers; scholarly
 *     texts with heavy annotation lose too much when footnotes are stripped.
 *
 *   - Classical scholarly texts ("Early works to 1800" subject without any
 *     popular-reading subject like Fiction/Adventure/Romance). Catches
 *     classical academic works (Plutarch, Suetonius) while preserving
 *     classic novels that also carry the "Early works" tag.
 *
 * The doc page is at docs/plans/2026-04-07-readmigo-curation-rules.md.
 */

export interface CurationCheckInput {
  title?: string;
  description?: string;
  subjects?: string[];
}

export interface CurationCheckResult {
  excluded: boolean;
  reason?: string;
}

// Epic narrative poems that ARE good for Readmigo even though they show up
// as "poetry" by subject — they read as continuous narratives.
const EPIC_POETRY_ALLOWLIST = [
  /\biliad\b/i,
  /\bodyssey\b/i,
  /\baeneid\b/i,
  /\bparadise lost\b/i,
  /\bdivine comedy\b/i,
  /\binferno\b/i,
  /\bpurgatorio\b/i,
  /\bparadiso\b/i,
  /\bbeowulf\b/i,
  /\bgilgamesh\b/i,
  /\bfaerie queene\b/i,
  /\bcanterbury tales\b/i,
  /\bnibelungenlied\b/i,
  /\bsong of roland\b/i,
  /\bmahabharata\b/i,
  /\bramayana\b/i,
];

const POETRY_SUBJECTS = [
  /\bpoetry\b/i,
  /\bpoems\b/i,
  /\bverses?\b/i,
  /\blyric poetry\b/i,
  /\bsonnets?\b/i,
];

const POETRY_TITLE_HINTS = [
  /\bpoems\b/i,
  /\bsonnets?\b/i,
  /\bsongs?\b/i,
  /\bballads?\b/i,
  /\bverses?\b/i,
  /\blyrics?\b/i,
];

const DRAMA_SUBJECTS = [
  /\bdrama\b/i,
  /\bplays\b/i,
  /\btragedy\b/i,
  /\btragedies\b/i,
  /\bcomedy\b/i,
  /\bcomedies\b/i,
  /\bone-act plays\b/i,
];

const MULTI_TRANSLATOR_PATTERNS = [
  /\bvarious translators?\b/i,
  /\btranslated by various\b/i,
  /\bvarious hands\b/i,
];

// Reference works (dictionaries, thesauruses, encyclopedias, glossaries)
// are not narrative content and should not appear in the Readmigo reader.
// Detected by either subjects or title hints.
const REFERENCE_SUBJECTS = [
  /\bdictionar/i,
  /\bthesaur/i,
  /\bencyclop[ae]di/i,
  /\bglossar/i,
  /\breference works?\b/i,
  /\bconcordance/i,
];

const REFERENCE_TITLE_HINTS = [
  /\bdictionary\b/i,
  /\bthesaurus\b/i,
  /\bencyclop[ae]dia\b/i,
  /\bcyclop[ae]dia\b/i,
  /\bglossary\b/i,
  /\bconcordance\b/i,
  /\bword[\s-]?book\b/i,
];

// Academic / non-popular subjects: Readmigo targets casual readers with
// accessible, easy-to-read content. Works that require specialist background
// knowledge — philosophy, political theory, literary criticism, academic
// history, theology — are excluded. Their heavy annotation and scholarly
// apparatus also causes content-fidelity issues when footnotes are stripped.
const ACADEMIC_SUBJECTS = [
  // Philosophy & ethics
  /\bphilosophy\b/i,
  /\bethics\b/i,
  /\bmetaphysics\b/i,
  /\bnihilism\b/i,
  /\bvalues\b/i,
  /\bmaxims\b/i,
  /\blogic\b/i,
  // Political theory & economics
  /\bpolitical science\b/i,
  /\bpolitical theory\b/i,
  /\beconomics\b/i,
  // Literary criticism & academic studies
  /\bliterary criticism\b/i,
  /\bcriticism\b/i,
  /\bwomen and literature\b/i,
  // Niche academic
  /\bprinting\b/i,
  /\bbibliography\b/i,
  /\bhistoriography\b/i,
  // Theology & apologetics
  /\btheology\b/i,
  /\bapologetics\b/i,
];

// "Early works to 1800" is a PG tag for pre-modern scholarly texts. Many
// classical novels also carry it, so we only exclude when the book does NOT
// also have a popular-reading subject.
const EARLY_WORKS_PATTERN = /\bearly works to \d+\b/i;
const POPULAR_SUBJECTS = [
  /\bfiction\b/i,
  /\badventure\b/i,
  /\bromance\b/i,
  /\bhorror\b/i,
  /\bmystery\b/i,
  /\bdetective\b/i,
  /\bhumor\b/i,
  /\bsatire\b/i,
  /\bchildren\b/i,
  /\bscience fiction\b/i,
  /\bfantasy\b/i,
  /\bgothic\b/i,
  /\btravel\b/i,
  /\bwar\b/i,
];

// Multi-volume cherry-picks: PG often splits long works into volumes and a
// reader landing on volume 1 alone gets a fragmentary experience. Detect
// titles with explicit volume markers and skip them — when the reader gains
// proper multi-volume support these can be reintroduced.
const MULTI_VOLUME_TITLE_PATTERNS = [
  /\bvol(?:ume|\.)?\s*(?:[ivxlcdm]+|\d+)\b/i, // "Volume 2", "Vol. III", "Vol. 1"
  /\bbook\s+(?:[ivxlcdm]+|\d+)\s+of\b/i,        // "Book II of", "Book 3 of"
  /\bpart\s+(?:[ivxlcdm]+|\d+)\s+of\b/i,        // "Part 1 of"
  /\bvolume\s+(?:[ivxlcdm]+|\d+)\s+of\b/i,
  /—\s*volume\s+(?:[ivxlcdm]+|\d+)\b/i,         // "My Life — Volume 1"
];

function isEpicAllowlisted(title: string): boolean {
  return EPIC_POETRY_ALLOWLIST.some((re) => re.test(title));
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * Discovery-time check. Returns excluded=true if a book matches any of the
 * curation rules detectable from Gutendex metadata alone (no body content
 * needed). Used by pg-discover.ts before creating a process job.
 */
export function isExcludedFromReadmigo(input: CurationCheckInput): CurationCheckResult {
  const title = (input.title || '').trim();
  const description = (input.description || '').trim();
  const subjects = input.subjects || [];

  // Multi-translator compilations are checked first because they can also
  // carry Drama/Poetry subjects that would otherwise grant a vague exclusion
  // reason — the multi-translator label is more specific.
  const blob = `${title} ${description} ${subjects.join(' ')}`;
  if (matchesAny(blob, MULTI_TRANSLATOR_PATTERNS)) {
    return { excluded: true, reason: 'multi-translator compilation' };
  }

  // Reference works: dictionaries, thesauruses, encyclopedias, glossaries.
  // Checked here (not after the drama / poetry checks) because reference
  // titles like "Roget's Thesaurus" should be flagged before any other
  // category match.
  for (const subject of subjects) {
    if (matchesAny(subject, REFERENCE_SUBJECTS)) {
      return { excluded: true, reason: `reference work (subject: ${subject})` };
    }
  }
  if (matchesAny(title, REFERENCE_TITLE_HINTS)) {
    return { excluded: true, reason: 'reference work (title)' };
  }

  // Multi-volume cherry-picks: a single PG volume of a multi-volume work
  // would land in Readmigo without its companion volumes. Skip until the
  // reader gains proper multi-volume series support.
  if (matchesAny(title, MULTI_VOLUME_TITLE_PATTERNS)) {
    return { excluded: true, reason: 'multi-volume single-volume cherry-pick' };
  }

  // Academic / non-popular subjects: philosophy, political theory, literary
  // criticism, theology, niche academic topics.
  for (const subject of subjects) {
    if (matchesAny(subject, ACADEMIC_SUBJECTS)) {
      return { excluded: true, reason: `academic/non-popular (subject: ${subject})` };
    }
  }

  // "Early works to 1800" without any popular-reading subject — these are
  // classical scholarly texts (Plutarch, Suetonius, etc.) that don't suit
  // casual readers.
  const hasEarlyWorks = subjects.some((s) => EARLY_WORKS_PATTERN.test(s));
  if (hasEarlyWorks) {
    const hasPopularSubject = subjects.some((s) => matchesAny(s, POPULAR_SUBJECTS));
    if (!hasPopularSubject) {
      return { excluded: true, reason: 'classical scholarly text (Early works, no popular subject)' };
    }
  }

  // Drama: any subject that looks dramatic. Plays do not get an allowlist
  // (yet) because the reader cannot render stage directions correctly.
  for (const subject of subjects) {
    if (matchesAny(subject, DRAMA_SUBJECTS)) {
      return { excluded: true, reason: `drama (subject: ${subject})` };
    }
  }

  // Poetry: subjects OR title hints, with an epic-narrative allowlist.
  const subjectIsPoetry = subjects.some((s) => matchesAny(s, POETRY_SUBJECTS));
  const titleIsPoetry = matchesAny(title, POETRY_TITLE_HINTS);
  if (subjectIsPoetry || titleIsPoetry) {
    if (isEpicAllowlisted(title)) {
      return { excluded: false };
    }
    return {
      excluded: true,
      reason: subjectIsPoetry ? 'lyric poetry (subject)' : 'lyric poetry (title)',
    };
  }

  return { excluded: false };
}

/**
 * Process-time check. Detects translator's-preface-dominant books — those
 * where the first extracted "chapter" overwhelms the rest of the book and
 * is labelled like front matter. Cannot be detected from metadata alone
 * because we need the actual chapter structure.
 *
 * Returns true if the book should be downgraded to needs_review.
 */
export function isPrefaceDominant(chapters: Array<{ title: string; wordCount: number }>): boolean {
  if (chapters.length < 2) return false;

  const totalWords = chapters.reduce((s, c) => s + c.wordCount, 0);
  if (totalWords === 0) return false;

  const first = chapters[0];
  const firstFraction = first.wordCount / totalWords;
  if (firstFraction < 0.3) return false;

  const lowerTitle = (first.title || '').toLowerCase();
  return /\b(introduction|preface|translator|foreword|prologue)\b/.test(lowerTitle);
}
