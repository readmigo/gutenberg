import * as cheerio from 'cheerio';
const EPub = require('epub2').EPub;

export interface ParsedMetadata {
  title: string;
  author: string;
  language: string;
  subjects: string[];
  description: string;
  coverImageId: string | null;
}

export interface ParsedChapter {
  order: number;
  title: string;
  href: string;
  htmlContent: string;
  wordCount: number;
}

export interface CoverData {
  data: Buffer;
  mimeType: string;
}

export interface EpubImage {
  id: string;
  href: string;
  mimeType: string;
  data: Buffer;
}

// Parse EPUB file
export function parseEpub(filePath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const epub = new EPub(filePath);
    epub.on('end', () => resolve(epub));
    epub.on('error', (err: Error) => reject(err));
    epub.parse();
  });
}

// Extract metadata
export function extractMetadata(epub: any): ParsedMetadata {
  return {
    title: epub.metadata?.title || 'Unknown',
    author: epub.metadata?.creator || 'Unknown',
    language: epub.metadata?.language || 'en',
    subjects: Array.isArray(epub.metadata?.subject)
      ? epub.metadata.subject
      : epub.metadata?.subject
        ? [epub.metadata.subject]
        : [],
    description: epub.metadata?.description || '',
    coverImageId: epub.metadata?.cover || null,
  };
}

// Get chapter content
function getChapterContent(epub: any, chapterId: string): Promise<string> {
  return new Promise((resolve) => {
    epub.getChapter(chapterId, (err: Error | null, text: string) => {
      if (err || !text) resolve('');
      else resolve(text);
    });
  });
}

// Extract cover image
export function extractCover(epub: any): Promise<CoverData | null> {
  return new Promise((resolve) => {
    if (!epub.metadata?.cover) {
      resolve(null);
      return;
    }
    epub.getImage(epub.metadata.cover, (err: Error | null, data: Buffer, mimeType: string) => {
      if (err || !data) resolve(null);
      else resolve({ data, mimeType });
    });
  });
}

// Extract all images from EPUB manifest
export async function extractImages(epub: any): Promise<EpubImage[]> {
  const manifest = epub.manifest || {};
  const coverId = epub.metadata?.cover;
  const images: EpubImage[] = [];

  for (const id of Object.keys(manifest)) {
    const item = manifest[id];
    const mediaType = item['media-type'] || item.mediaType || '';
    if (!mediaType.startsWith('image/')) continue;
    // Skip cover image (handled separately)
    if (id === coverId) continue;

    try {
      const imageData = await new Promise<{ data: Buffer; mimeType: string } | null>((resolve) => {
        epub.getImage(id, (err: Error | null, data: Buffer, mime: string) => {
          if (err || !data) resolve(null);
          else resolve({ data, mimeType: mime });
        });
      });
      if (imageData) {
        images.push({
          id,
          href: item.href || '',
          mimeType: imageData.mimeType,
          data: imageData.data,
        });
      }
    } catch {
      // Skip images that can't be extracted
    }
  }

  return images;
}

// Phrases that almost only appear in title pages / front matter in
// pre-1923 English books. "AUTHOR OF" and "BY THE AUTHOR OF" are the
// strongest signals — authors were credited this way on title pages of
// the era but the phrase rarely appears in narrative prose. The other
// markers catch bibliographic and copyright notices.
const TITLE_PAGE_MARKERS = [
  /\bBY THE AUTHOR OF\b/,
  /\bPRINTED FOR\b/,
  /\bCOPYRIGHT\s+(?:BY|\d{4})/,
  /\bALL RIGHTS RESERVED\b/,
  /\bFIRST (?:PUBLISHED|EDITION|PRINTED)\b/,
  /\bPUBLISHED\s+(?:IN|BY)\b/,
];

/**
 * Detect content-level front-matter signals that apply regardless of where
 * a chapter appears in the book:
 *   1. Very short (<30 words) — obvious junk (volume dividers, blank pages).
 *   2. Any length but the first 500 characters match a title-page marker
 *      phrase like "AUTHOR OF" or "COPYRIGHT BY" — catches the 32,000-word
 *      "THE FOUR FEATHERS BY A. E. W. MASON AUTHOR OF..." blob where PG
 *      merges title page + preface + prologue into a single anchor range.
 *
 * Position-based short-chapter filtering (the "Courtship of Maurice Buckler"
 * style back-matter advertisement) is handled separately in
 * `dropEdgeFrontMatter` so that mid-book short entries like Aesop's fables
 * are not mistaken for junk.
 */
function isFrontMatterFragment(title: string, wordCount: number, rawHtml: string): boolean {
  if (wordCount < 30) return true;

  const sample = stripHtml(rawHtml).slice(0, 500).toUpperCase();
  for (const re of TITLE_PAGE_MARKERS) {
    if (re.test(sample)) return true;
  }
  return false;
}

/**
 * Post-processing pass that drops short non-narrative chapters that sit at
 * the very beginning or end of the extracted list. The intent is to catch
 * front-matter blurbs and back-matter advertising blocks without touching
 * mid-book short entries (poems, fables, vignettes).
 *
 * "Edge" here means: among the first few or last few chapters of the list,
 * the chapter is short AND not labeled with a chapter/book/part-style
 * heading AND its removal would not leave the book empty.
 */
function dropEdgeFrontMatter(chapters: ParsedChapter[]): ParsedChapter[] {
  if (chapters.length <= 3) return chapters;

  const SHORT = 300;
  const EDGE_WINDOW = 3;
  const keywordRe =
    /\b(chapter|book|part|prologue|epilogue|introduction|preface|foreword|appendix|act|scene|canto|volume|letter)\b/i;
  // Roman numerals as standalone titles (I, II, III, IV, V, ..., XL, L) indicate
  // numbered chapters/letters — not front matter.
  const romanNumeralRe = /^[IVXLCDM]+$/i;

  const hasNarrativeKeyword = (ch: ParsedChapter): boolean => {
    const title = (ch.title || '').trim();
    return keywordRe.test(title) || romanNumeralRe.test(title);
  };

  // Strip from the head as long as the first chapter is short-and-untitled
  // and sits inside the edge window.
  let head = 0;
  while (
    head < Math.min(EDGE_WINDOW, chapters.length - 1) &&
    chapters[head].wordCount < SHORT &&
    !hasNarrativeKeyword(chapters[head])
  ) {
    head++;
  }

  // Strip from the tail similarly.
  let tail = chapters.length;
  while (
    tail > Math.max(chapters.length - EDGE_WINDOW, head + 1) &&
    chapters[tail - 1].wordCount < SHORT &&
    !hasNarrativeKeyword(chapters[tail - 1])
  ) {
    tail--;
  }

  if (head === 0 && tail === chapters.length) return chapters;
  return chapters
    .slice(head, tail)
    .map((ch, i) => ({ ...ch, order: i + 1 }));
}

// Detect license/colophon chapters to skip. Uses word-boundary matching on
// the title so that legitimate chapter headings containing substrings like
// "Covering a screen" (Pride and Prejudice ch. VIII) are not filtered out.
// The href check uses plain substring matching because PG file names like
// `cover.jpg.id-NNN.wrap-0.html.xhtml` are unambiguous indicators.
const SKIP_TITLE_KEYWORDS = [
  'colophon',
  'imprint',
  'license',
  'copyright',
  'uncopyright',
  'endnotes',
  'cover',
  'titlepage',
  'cover image',
  'book cover',
  'front cover',
];
const SKIP_TITLE_REGEXES = SKIP_TITLE_KEYWORDS.map(
  (kw) => new RegExp(`\\b${kw.replace(/ /g, '\\s+')}\\b`, 'i'),
);

function isSkippableChapter(title: string, href?: string): boolean {
  const lowerHref = (href || '').toLowerCase();
  if (title) {
    for (const re of SKIP_TITLE_REGEXES) {
      if (re.test(title)) return true;
    }
  }
  return lowerHref.includes('cover') || lowerHref.includes('titlepage');
}

// Strip HTML for word count
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Extract a chapter title from the first heading found inside a segment of
 * HTML. Looks at h1..h3 in document order, returns the text content of the
 * first qualifying match with whitespace collapsed. Returns null if no
 * usable heading is found.
 *
 * Used to replace the TOC-derived title (which on PG illustrated editions
 * is often polluted with illustration captions) with the heading actually
 * printed in the chapter body.
 *
 * Two pollution patterns we filter:
 *
 *   1. Illustration caption inside the heading (PG illustrated editions
 *      wrap a `<span class="caption">…</span>` next to the chapter label):
 *
 *        <h2 id="..."><img .../><span class="caption">I hope Mr. Bingley
 *        will like it.</span><br/><br/>CHAPTER II.</h2>
 *
 *      We drop caption / illustration children before reading text.
 *
 *   2. PG header / front-matter headings whose text begins with
 *      "The Project Gutenberg eBook of …" — these come from the
 *      pg-boilerplate `<section>` that the content cleaner will strip
 *      later. If we use them as the chapter title we get every book's
 *      first chapter named after the boilerplate. Skip such headings
 *      and try the next h1/h2/h3 in document order.
 */
export function extractTitleFromSegment(html: string): string | null {
  if (!html) return null;
  const $ = cheerio.load(html);
  const headings = $('h1, h2, h3');
  if (headings.length === 0) return null;

  for (let i = 0; i < headings.length; i++) {
    // Work on a clone so we don't mutate the caller's parse tree. Drop image
    // children and any span/div carrying a class that suggests a caption or
    // illustration label; what remains should be the real chapter heading.
    const clone = $(headings[i]).clone();
    clone.find('img').remove();
    clone.find('[class*="caption" i]').remove();
    clone.find('[class*="illustration" i]').remove();

    const text = clone.text().replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // Guard against titles that are themselves junk (numbers or punctuation).
    if (!/[A-Za-z0-9]{2,}/.test(text)) continue;
    // Skip PG boilerplate headings — try the next heading in document order.
    if (/project gutenberg|ebook of|gutenberg ebook|gutenberg license/i.test(text)) {
      continue;
    }
    return text;
  }
  return null;
}

/**
 * Split a single XHTML file's content into per-chapter segments, keyed by
 * anchor IDs from the TOC. Used when a PG-style multi-chapter-per-file
 * layout packs many TOC entries into a single physical file via #anchors.
 *
 * Strategy: scan the raw HTML as a string, find the character offset where
 * each anchor's opening tag begins, and slice the HTML between consecutive
 * offsets in document order. Slicing at character level sidesteps the DOM
 * ancestry problems of the sibling-walk approach — if two anchors live at
 * different nesting depths (e.g. one on a top-level title-page header and
 * one on an `<h2>` inside a chapter `<div>`), the range between them in
 * document order is exactly the content we want regardless of ancestry.
 *
 * The resulting slices are HTML fragments, not well-formed documents —
 * an opening `<div>` in slice N may have its closing tag in slice N+3.
 * This is fine for the downstream pipeline: stripHtml drops tags entirely,
 * the content-cleaner works on text nodes, and the semanticizer wraps its
 * output in a fresh `<section>` anyway.
 *
 * Returns an array of HTML strings in the same order as `anchorIds`. If an
 * anchor cannot be located, its slot is returned as an empty string so the
 * caller can preserve ordering; callers should filter empties.
 */
export function splitFileByAnchors(html: string, anchorIds: string[]): string[] {
  if (!html || anchorIds.length === 0) return [];

  // For each anchor, find the character offset of the tag that owns the
  // `id="…"` attribute. We locate the attribute occurrence and walk back
  // to the nearest `<` to anchor on the owning tag's opening.
  const offsetByAnchorIndex = new Map<number, number>();
  for (let i = 0; i < anchorIds.length; i++) {
    const id = anchorIds[i];
    // Escape any regex specials; id values in PG EPUBs are alphanumeric +
    // underscore / digits but we defend against hypothetical punctuation.
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const attrMatcher = new RegExp(`id=["']?${escaped}["']?`);
    const found = attrMatcher.exec(html);
    if (!found) continue;
    const tagStart = html.lastIndexOf('<', found.index);
    if (tagStart === -1) continue;
    offsetByAnchorIndex.set(i, tagStart);
  }

  // Sort all located anchors by document order and compute each segment's
  // end offset as the next anchor's start in document order (or EOF).
  const orderedByDocument = [...offsetByAnchorIndex.entries()]
    .map(([anchorIndex, offset]) => ({ anchorIndex, offset }))
    .sort((a, b) => a.offset - b.offset);

  const segments: string[] = new Array(anchorIds.length).fill('');
  for (let i = 0; i < anchorIds.length; i++) {
    const startOffset = offsetByAnchorIndex.get(i);
    if (startOffset === undefined) continue;
    let endOffset = html.length;
    for (const doc of orderedByDocument) {
      if (doc.offset > startOffset) {
        endOffset = doc.offset;
        break;
      }
    }
    segments[i] = html.slice(startOffset, endOffset);
  }

  return segments;
}

/**
 * Merge orphaned flow items (spine entries without TOC references) into the
 * preceding chapter. PG illustrated editions and long-chapter books split
 * chapters across multiple XHTML files — the TOC points to the first file
 * only, and continuation files (including illustration wrappers) appear in
 * the spine without any TOC entry. These must be appended to the preceding
 * chapter rather than dropped.
 *
 * When an orphaned item appears before the first chapter (front matter), it
 * is added as an independent chapter only if it has substantial content
 * (>= 200 words) — this preserves the "A Modest Proposal" recovery where
 * the main essay has no TOC pointer.
 */
async function mergeOrphanedFlowItems(
  chapters: ParsedChapter[],
  epub: any,
  flow: any[],
  referencedFlowIds: Set<string>,
  flowIdToLastChapterIndex: Map<string, number>,
): Promise<void> {
  let currentChapterIndex = -1;

  for (const flowItem of flow) {
    if (referencedFlowIds.has(flowItem.id)) {
      const idx = flowIdToLastChapterIndex.get(flowItem.id);
      if (idx !== undefined) currentChapterIndex = idx;
      continue;
    }

    // Skip cover / titlepage / license / colophon files
    const lowerHref = (flowItem.href || '').toLowerCase();
    if (
      lowerHref.includes('cover') ||
      lowerHref.includes('titlepage') ||
      lowerHref.includes('uncopyright') ||
      lowerHref.includes('colophon') ||
      lowerHref.includes('endnotes') ||
      lowerHref.includes('loi') // list of illustrations
    ) continue;
    if (
      flowItem.id === 'pg-header' ||
      flowItem.id === 'pg-footer' ||
      lowerHref.endsWith('-h-0.htm.html') ||
      lowerHref.endsWith('-h-0.htm.xhtml')
    ) {
      continue;
    }

    const html = await getChapterContent(epub, flowItem.id);
    if (!html || html.length < 50) continue;

    const text = stripHtml(html);
    const wordCount = countWords(text);
    if (wordCount < 5) continue;

    // Skip PG boilerplate / license
    if (/project gutenberg|gutenberg ebook|gutenberg license/i.test(text.slice(0, 300))) continue;

    if (currentChapterIndex >= 0 && currentChapterIndex < chapters.length) {
      // Merge into the preceding chapter (continuation file)
      const target = chapters[currentChapterIndex];
      target.htmlContent += '\n' + html;
      target.wordCount += wordCount;
      console.log(
        `  [epub-parser] merging orphaned flow item ${flowItem.id} (${wordCount} words) into "${target.title}"`,
      );
    } else if (wordCount >= 200) {
      // No preceding chapter — add as independent chapter
      const headingTitle = extractTitleFromSegment(html);
      const title = headingTitle || `Chapter ${chapters.length + 1}`;
      if (isSkippableChapter(title, flowItem.href)) continue;
      if (isFrontMatterFragment(title, wordCount, html)) continue;
      console.log(
        `  [epub-parser] adding orphaned flow item ${flowItem.id} -> ${flowItem.href} (${wordCount} words)`,
      );
      chapters.push({
        order: chapters.length + 1,
        title,
        href: flowItem.href || '',
        htmlContent: html,
        wordCount,
      });
    }
  }
}

/**
 * Return the HTML content before the first located anchor in a file.
 * Used by the anchor-split path to recover text that precedes the first
 * TOC-referenced heading — typically a chapter continuation from the
 * previous file, or a preamble before the first chapter in that file.
 *
 * Returns null if there's nothing meaningful (< 50 words or PG boilerplate).
 */
function getPreAnchorContent(html: string, anchorIds: string[]): string | null {
  if (!html || anchorIds.length === 0) return null;

  // Find the earliest anchor's offset in the document
  let earliestOffset = html.length;
  for (const id of anchorIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`id=["']?${escaped}["']?`).exec(html);
    if (!m) continue;
    const tagStart = html.lastIndexOf('<', m.index);
    if (tagStart >= 0 && tagStart < earliestOffset) {
      earliestOffset = tagStart;
    }
  }
  if (earliestOffset === 0 || earliestOffset === html.length) return null;

  const preHtml = html.slice(0, earliestOffset);
  const preText = stripHtml(preHtml);
  const preWords = countWords(preText);
  if (preWords < 50) return null;

  // Skip PG boilerplate (license headers/footers)
  if (/project gutenberg|gutenberg ebook|gutenberg license|\*\*\* (?:START|END) OF/i.test(
    preText.slice(0, 500),
  )) {
    return null;
  }

  return preHtml;
}

// Extract chapters from EPUB
export async function extractChapters(epub: any): Promise<ParsedChapter[]> {
  const chapters: ParsedChapter[] = [];
  const toc = epub.toc || [];
  const flow = epub.flow || [];

  // Multi-chapter-per-file detection: PG "Illustrated" editions pack many
  // chapters into a single XHTML file and reference each chapter by #anchor
  // in the TOC. When we detect this (TOC entries >> unique files), we can
  // either (a) split each file by its anchors, preserving one chapter per
  // TOC entry, or (b) fall back to one chapter per file.
  let useAnchorSplit = false;
  if (toc.length > 0 && flow.length > 0) {
    const uniqueHrefs = new Set<string>();
    for (const t of toc) {
      const base = (t.href || '').split('#')[0];
      if (base) uniqueHrefs.add(base);
    }
    if (uniqueHrefs.size > 0 && toc.length > uniqueHrefs.size * 1.5) {
      useAnchorSplit = true;
      console.log(
        `  [epub-parser] multi-chapter-per-file layout detected ` +
          `(${toc.length} TOC entries / ${uniqueHrefs.size} files); splitting by anchors`,
      );
    }
  }

  if (useAnchorSplit) {
    // Filter TOC down to chapter-level entries when the TOC includes many
    // sub-section labels. PG editions of Leviathan, Wealth of Nations, etc.
    // list every marginal heading in the TOC alongside the real chapter
    // labels — 720 entries for a 47-chapter book. If >= 5 entries match a
    // /chapter\s+(N|roman)/ pattern, use only those as anchor boundaries
    // and let sub-sections be merged into the parent chapter's segment.
    const chapterStyleRe = /\b(?:chapter|book|part|canto|act|scene|prologue|epilogue|introduction|preface|foreword)\s+(?:\d+|[ivxlcdm]+)\b/i;
    const chapterStyleEntries = toc.filter((t: any) =>
      chapterStyleRe.test(t.title || ''),
    );
    let workingToc = toc;
    if (chapterStyleEntries.length >= 5 && chapterStyleEntries.length < toc.length / 2) {
      console.log(
        `  [epub-parser] TOC has ${toc.length} entries but ${chapterStyleEntries.length} look like chapter headings — using only those`,
      );
      workingToc = chapterStyleEntries;
    }

    // Group TOC entries by physical file while preserving TOC order.
    type TocEntry = { title: string; href: string; baseHref: string; anchor: string };
    const byFile = new Map<string, TocEntry[]>();
    const fileOrder: string[] = [];
    for (const t of workingToc) {
      const href = t.href || '';
      const [baseHref, anchor] = href.split('#');
      if (!baseHref || !anchor) continue;
      if (!byFile.has(baseHref)) {
        byFile.set(baseHref, []);
        fileOrder.push(baseHref);
      }
      byFile.get(baseHref)!.push({
        title: (t.title || '').trim(),
        href,
        baseHref,
        anchor,
      });
    }

    // Iterate files in their TOC appearance order. For each, load content
    // once and split by anchors.
    const flowIdToLastChapterIndex = new Map<string, number>();
    for (const baseHref of fileOrder) {
      const entries = byFile.get(baseHref)!;
      const flowItem = flow.find(
        (f: any) => f.href === baseHref || f.href?.endsWith(baseHref),
      );
      if (!flowItem) continue;
      const fileHtml = await getChapterContent(epub, flowItem.id);
      if (!fileHtml || fileHtml.length < 100) continue;
      const chapCountBefore = chapters.length;

      const anchorIds = entries.map((e) => e.anchor);
      const segments = splitFileByAnchors(fileHtml, anchorIds);

      // Recover content before the first anchor in this file. This is
      // typically either (a) the continuation of the last chapter from the
      // previous file, or (b) a preamble in the first content file.
      // If there's a previous chapter, append to it (case a); otherwise
      // prepend to the first segment of this file (case b).
      const preAnchor = getPreAnchorContent(fileHtml, anchorIds);
      if (preAnchor) {
        const preWords = countWords(stripHtml(preAnchor));
        if (chapCountBefore > 0) {
          // Append to the last chapter from the previous file
          const prev = chapters[chapCountBefore - 1];
          prev.htmlContent += '\n' + preAnchor;
          prev.wordCount += preWords;
          console.log(
            `  [epub-parser] appending ${preWords} pre-anchor words to previous chapter "${prev.title}"`,
          );
        } else if (segments[0]) {
          // First file — prepend to first segment
          segments[0] = preAnchor + segments[0];
          console.log(
            `  [epub-parser] prepending ${preWords} pre-anchor words to first segment`,
          );
        }
      }

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const segment = segments[i] || '';
        if (isSkippableChapter(entry.title, entry.href)) continue;
        if (!segment || segment.length < 100) continue;

        const wordCount = countWords(stripHtml(segment));
        if (wordCount === 0) continue;

        // Prefer the in-body heading (cleaner, avoids illustration captions
        // pasted into TOC labels) with a fallback to the TOC title.
        const headingTitle = extractTitleFromSegment(segment);
        const title = headingTitle || entry.title || `Chapter ${chapters.length + 1}`;
        if (isSkippableChapter(title, entry.href)) continue;
        if (isFrontMatterFragment(title, wordCount, segment)) continue;

        chapters.push({
          order: chapters.length + 1,
          title,
          href: entry.href,
          htmlContent: segment,
          wordCount,
        });
      }
      if (chapters.length > chapCountBefore) {
        flowIdToLastChapterIndex.set(flowItem.id, chapters.length - 1);
      }
    }

    // Merge orphaned flow items (continuation files, illustration wrappers)
    // into the preceding chapter. Catches PG editions that split chapters
    // across multiple XHTML files.
    const referencedFlowIds = new Set<string>();
    for (const baseHref of fileOrder) {
      const f = flow.find(
        (it: any) => it.href === baseHref || it.href?.endsWith(baseHref),
      );
      if (f) referencedFlowIds.add(f.id);
    }

    await mergeOrphanedFlowItems(chapters, epub, flow, referencedFlowIds, flowIdToLastChapterIndex);

    return dropEdgeFrontMatter(dedupeByContentHash(chapters));
  }

  // Normal path: one chapter per TOC entry (or per flow item if no TOC).
  const items = toc.length > 0 ? toc : flow;
  const referencedFlowIds = new Set<string>();
  const flowIdToLastChapterIndex = new Map<string, number>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tocTitle = item.title?.trim() || `Chapter ${i + 1}`;

    if (isSkippableChapter(tocTitle, item.href)) continue;

    const baseHref = (item.href || '').split('#')[0];
    const flowItem = flow.find((f: any) => f.href === baseHref || f.href?.endsWith(baseHref));
    let content = '';

    if (flowItem) {
      referencedFlowIds.add(flowItem.id);
      content = await getChapterContent(epub, flowItem.id);
    }

    if (!content || content.length < 100) continue;

    // Prefer in-body heading over TOC title when available.
    const headingTitle = extractTitleFromSegment(content);
    const title = headingTitle || tocTitle;
    if (isSkippableChapter(title, item.href)) continue;

    const wordCount = countWords(stripHtml(content));
    if (isFrontMatterFragment(title, wordCount, content)) continue;
    chapters.push({
      order: chapters.length + 1,
      title,
      href: item.href || '',
      htmlContent: content,
      wordCount,
    });
    if (flowItem) {
      flowIdToLastChapterIndex.set(flowItem.id, chapters.length - 1);
    }
  }

  // Merge orphaned flow items (continuation files, illustration wrappers)
  // into the preceding chapter.
  await mergeOrphanedFlowItems(chapters, epub, flow, referencedFlowIds, flowIdToLastChapterIndex);

  return dropEdgeFrontMatter(dedupeByContentHash(chapters));
}

/**
 * Drop chapters whose first 500 characters of stripped text match an earlier
 * chapter. This handles two related cases:
 *
 *   1. Multiple TOC entries pointing to the same file via different anchors
 *      that the splitter couldn't separate (Alice: 3 front-matter entries
 *      sharing one file).
 *   2. PG editions that include duplicated boilerplate — front matter that
 *      appears once per volume, or back-matter advertising other works by
 *      the same author. The Four Feathers (#18883) has the title page
 *      repeated 3x and a "Courtship of Maurice Buckler" ad repeated 2x,
 *      contributing ~97k duplicate words on top of a 107k-word novel.
 *
 * Applied uniformly after both the anchor-split and TOC paths so neither
 * can leak duplicates downstream.
 */
function dedupeByContentHash(chapters: ParsedChapter[]): ParsedChapter[] {
  const seenHashes = new Set<string>();
  const deduped: ParsedChapter[] = [];
  for (const ch of chapters) {
    const prefix = stripHtml(ch.htmlContent).slice(0, 500);
    if (!prefix) continue;
    if (seenHashes.has(prefix)) {
      console.warn(
        `  [epub-parser] dropping duplicate chapter "${ch.title}" (same content as earlier chapter)`,
      );
      continue;
    }
    seenHashes.add(prefix);
    deduped.push({ ...ch, order: deduped.length + 1 });
  }
  return deduped;
}
