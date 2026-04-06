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

/**
 * Detect front-matter / divider chapters that should never be treated as
 * narrative content. These are things like title pages, volume dividers,
 * dedications, and publication notices in PG's multi-volume first editions.
 *
 * The heuristic: a chapter is junk if its raw word count is very low AND
 * its title does not look like an actual chapter/book/part label. The
 * explicit "chapter/book/part" allowlist keeps legitimately short chapters
 * (e.g. a 60-word prologue explicitly titled "Prologue") from being lost.
 */
function isFrontMatterFragment(title: string, wordCount: number): boolean {
  // Clearly empty or near-empty — filter outright regardless of title.
  if (wordCount < 30) return true;
  // Short segment that is not labeled as a chapter/prologue/epilogue/part.
  // 200 words is the threshold below which P&P title pages (~14-54 words)
  // and volume dividers reliably land, while a real 676-word short chapter
  // like P&P ch. XII passes through comfortably.
  if (wordCount < 200) {
    const lower = (title || '').toLowerCase();
    if (!/\b(chapter|book|part|prologue|epilogue|introduction|preface|foreword|appendix|act|scene|canto|volume)\b/.test(lower)) {
      return true;
    }
  }
  return false;
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
 * first match with whitespace collapsed. Returns null if no heading is found.
 *
 * Used to replace the TOC-derived title (which on PG illustrated editions
 * is often polluted with illustration captions) with the heading actually
 * printed in the chapter body.
 *
 * PG illustrated editions routinely wrap the chapter h2 around BOTH an
 * illustration caption span AND the chapter label, e.g.
 *
 *   <h2 id="..."><img .../><span class="caption">I hope Mr. Bingley will
 *   like it.</span><br/><br/>CHAPTER II.</h2>
 *
 * A naive `.text()` would concatenate the two into the same polluted string
 * we saw in the TOC label. To get just the chapter label we clone the
 * heading, drop any caption children, and only then serialize text.
 */
export function extractTitleFromSegment(html: string): string | null {
  if (!html) return null;
  const $ = cheerio.load(html);
  const heading = $('h1, h2, h3').first();
  if (heading.length === 0) return null;

  // Work on a clone so we don't mutate the caller's parse tree. Drop image
  // children and any span/div carrying a class that suggests a caption or
  // illustration label; what remains should be the real chapter heading.
  const clone = heading.clone();
  clone.find('img').remove();
  clone.find('[class*="caption" i]').remove();
  clone.find('[class*="illustration" i]').remove();

  const text = clone.text().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // Guard against titles that are themselves junk (e.g. just numbers or
  // a single punctuation mark). Require at least 2 alphanumeric characters.
  if (!/[A-Za-z0-9]{2,}/.test(text)) return null;
  return text;
}

/**
 * Split a single XHTML file's content into per-chapter segments, keyed by
 * anchor IDs from the TOC. Used when a PG-style multi-chapter-per-file
 * layout packs many TOC entries into a single physical file via #anchors.
 *
 * Strategy: for each anchor, locate the element with that id, walk upward
 * until it sits at the same DOM depth as the other anchors' containing
 * elements, then collect that element plus all following siblings until
 * the next anchor's element (or end of parent).
 *
 * Returns an array of HTML strings in the same order as `anchorIds`.
 * If an anchor cannot be located, its slot is returned as an empty string
 * so the caller can preserve ordering; callers should filter empties.
 */
export function splitFileByAnchors(html: string, anchorIds: string[]): string[] {
  if (!html || anchorIds.length === 0) return [];

  // cheerio.load with `xmlMode: false` is sufficient for XHTML;
  // setting the second arg to null keeps cheerio's default options.
  const $ = cheerio.load(html);

  // Resolve each anchor id to a "chapter block" element: the deepest
  // ancestor (including the element itself) whose parent is shared with
  // the other anchors. In the common case (PG Illustrated editions) the
  // anchor is an <h2 id="..."> at body level, so no walking is needed.
  // For robustness we still search for a common-ancestor depth.
  const anchorElems: Array<ReturnType<typeof $>> = [];
  for (const id of anchorIds) {
    // Use attribute-equals selector to avoid CSS escaping issues with ids
    // that contain punctuation / start with digits.
    const cssEscaped = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const el = $(`[id="${cssEscaped}"]`).first();
    anchorElems.push(el);
  }

  // For each anchor, lift it up the tree to the element whose parent is
  // the common ancestor of all anchor elements. We approximate "common
  // ancestor" by finding the deepest element that is an ancestor (or
  // self) of every non-empty anchor. In practice the <body> or its first
  // container suffices.
  const commonAncestor = findCommonAncestor(
    $,
    anchorElems.filter((e) => e.length > 0).map((e) => e[0] as any),
  );

  const liftedBlocks: Array<ReturnType<typeof $>> = anchorElems.map((el) => {
    if (el.length === 0) return el;
    let current: any = el[0];
    while (current && current.parent && current.parent !== commonAncestor) {
      current = current.parent;
    }
    return $(current);
  });

  const segments: string[] = [];
  for (let i = 0; i < liftedBlocks.length; i++) {
    const block = liftedBlocks[i];
    if (block.length === 0) {
      segments.push('');
      continue;
    }
    const next = liftedBlocks.slice(i + 1).find((b) => b.length > 0);
    const parts: string[] = [$.html(block)];
    let sibling = block.next();
    while (sibling.length > 0) {
      if (next && next.length > 0 && sibling[0] === next[0]) break;
      parts.push($.html(sibling));
      sibling = sibling.next();
    }
    segments.push(parts.join('\n'));
  }

  return segments;
}

/**
 * Find the deepest element that is an ancestor (or self) of every node in
 * the list. Returns undefined if the input is empty. Used by
 * splitFileByAnchors to know when to stop walking up from each anchor.
 */
function findCommonAncestor($: cheerio.CheerioAPI, nodes: any[]): any {
  if (nodes.length === 0) return undefined;
  if (nodes.length === 1) return nodes[0].parent;
  // Collect ancestor chain for each node (root → self).
  const chains: any[][] = nodes.map((n) => {
    const chain: any[] = [];
    let cur: any = n;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parent;
    }
    return chain;
  });
  // Find the longest common prefix of the chains.
  let common: any = undefined;
  const minLen = Math.min(...chains.map((c) => c.length));
  for (let i = 0; i < minLen; i++) {
    const ref = chains[0][i];
    if (chains.every((c) => c[i] === ref)) {
      common = ref;
    } else {
      break;
    }
  }
  return common;
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
    // Group TOC entries by physical file while preserving TOC order.
    type TocEntry = { title: string; href: string; baseHref: string; anchor: string };
    const byFile = new Map<string, TocEntry[]>();
    const fileOrder: string[] = [];
    for (const t of toc) {
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
    for (const baseHref of fileOrder) {
      const entries = byFile.get(baseHref)!;
      const flowItem = flow.find(
        (f: any) => f.href === baseHref || f.href?.endsWith(baseHref),
      );
      if (!flowItem) continue;
      const fileHtml = await getChapterContent(epub, flowItem.id);
      if (!fileHtml || fileHtml.length < 100) continue;

      const anchorIds = entries.map((e) => e.anchor);
      const segments = splitFileByAnchors(fileHtml, anchorIds);

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
        if (isFrontMatterFragment(title, wordCount)) continue;

        chapters.push({
          order: chapters.length + 1,
          title,
          href: entry.href,
          htmlContent: segment,
          wordCount,
        });
      }
    }

    return chapters;
  }

  // Normal path: one chapter per TOC entry (or per flow item if no TOC).
  const items = toc.length > 0 ? toc : flow;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tocTitle = item.title?.trim() || `Chapter ${i + 1}`;

    if (isSkippableChapter(tocTitle, item.href)) continue;

    const baseHref = (item.href || '').split('#')[0];
    const flowItem = flow.find((f: any) => f.href === baseHref || f.href?.endsWith(baseHref));
    let content = '';

    if (flowItem) {
      content = await getChapterContent(epub, flowItem.id);
    }

    if (!content || content.length < 100) continue;

    // Prefer in-body heading over TOC title when available.
    const headingTitle = extractTitleFromSegment(content);
    const title = headingTitle || tocTitle;
    if (isSkippableChapter(title, item.href)) continue;

    const wordCount = countWords(stripHtml(content));
    if (isFrontMatterFragment(title, wordCount)) continue;
    chapters.push({
      order: chapters.length + 1,
      title,
      href: item.href || '',
      htmlContent: content,
      wordCount,
    });
  }

  // Final dedupe pass: when multiple TOC entries point to the same file via
  // different #anchors that the splitter couldn't separate (e.g. Alice has 3
  // front-matter entries in one file — "Alice's Adventures in Wonderland",
  // "THE MILLENNIUM FULCRUM EDITION", "Contents" — all below the anchor-split
  // ratio threshold), we end up with multiple chapters carrying identical
  // content. Keep only the first occurrence of any duplicated content block
  // so the book output stays clean without having to tune the threshold.
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
