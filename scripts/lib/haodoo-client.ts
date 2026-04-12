import axios from 'axios';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.haodoo.net';
const USER_AGENT = 'Readmigo-Bot/1.0 (book pipeline)';

export interface HaodooBook {
  sourceBookId: string;  // derived from download URL
  title: string;
  author: string;
  category: string;
  downloadUrl: string;   // EPUB download URL
  sourceUrl: string;     // catalog page URL
  format: 'epub' | 'pdb';
}

const CATEGORIES: Array<{ name: string; path: string }> = [
  { name: '世纪百强', path: '/century' },
  { name: '武侠小说', path: '/wuxia' },
  { name: '言情小说', path: '/romance' },
  { name: '推理小说', path: '/mystery' },
  { name: '奇幻小说', path: '/fantasy' },
  { name: '历史小说', path: '/history' },
  { name: '随身智囊', path: '/classics' },
];

/**
 * Extract a sourceBookId from the filename portion of a download URL.
 * e.g. https://www.haodoo.net/download/epub/M123.epub → "M123"
 */
function extractBookId(downloadUrl: string): string {
  const parts = downloadUrl.split('/');
  const filename = parts[parts.length - 1];
  return filename.replace(/\.(epub|pdb)$/i, '');
}

/**
 * Parse title and author from link text.
 * Common formats on haodoo.net:
 *   "書名／作者"  (full-width slash)
 *   "書名/作者"   (half-width slash)
 *   "書名-作者"   (hyphen)
 *   "書名　作者"  (just the title with no author in anchor text)
 */
function parseTitleAuthor(text: string): { title: string; author: string } {
  const cleaned = text.trim();

  // Try full-width slash first (most common on haodoo)
  if (cleaned.includes('／')) {
    const idx = cleaned.indexOf('／');
    return {
      title: cleaned.slice(0, idx).trim(),
      author: cleaned.slice(idx + 1).trim(),
    };
  }

  // Half-width slash
  if (cleaned.includes('/')) {
    const idx = cleaned.indexOf('/');
    return {
      title: cleaned.slice(0, idx).trim(),
      author: cleaned.slice(idx + 1).trim(),
    };
  }

  // Hyphen separator (guard against titles that simply contain a hyphen by
  // checking that there are non-whitespace chars on both sides)
  const hyphenMatch = cleaned.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (hyphenMatch) {
    return {
      title: hyphenMatch[1].trim(),
      author: hyphenMatch[2].trim(),
    };
  }

  // Fallback: title only, no author found
  return { title: cleaned, author: '' };
}

/**
 * Fetch a single category page from haodoo.net and return all EPUB books
 * listed there.  Cheerio selectors are based on the typical haodoo markup;
 * they may need adjustment when tested against the live site.
 */
export async function scrapeCategory(
  categoryPath: string,
  categoryName: string,
): Promise<HaodooBook[]> {
  const sourceUrl = `${BASE_URL}${categoryPath}`;
  try {
    const { data: html } = await axios.get<string>(sourceUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 30_000,
      maxRedirects: 5,
    });

    const $ = cheerio.load(html);
    const books: HaodooBook[] = [];

    // Primary selector: anchors whose href ends with ".epub"
    $('a[href$=".epub"]').each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      if (!href) return;

      const downloadUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      const sourceBookId = extractBookId(downloadUrl);
      if (!sourceBookId) return;

      const linkText = $(el).text();
      const { title, author } = parseTitleAuthor(linkText);

      books.push({
        sourceBookId,
        title: title || sourceBookId,
        author,
        category: categoryName,
        downloadUrl,
        sourceUrl,
        format: 'epub',
      });
    });

    // Secondary pass: .pdb links (older haodoo format, kept for completeness)
    $('a[href$=".pdb"]').each((_i, el) => {
      const href = $(el).attr('href') ?? '';
      if (!href) return;

      const downloadUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      const sourceBookId = extractBookId(downloadUrl);
      if (!sourceBookId) return;

      // Skip if we already have an EPUB variant for the same book
      if (books.some((b) => b.sourceBookId === sourceBookId)) return;

      const linkText = $(el).text();
      const { title, author } = parseTitleAuthor(linkText);

      books.push({
        sourceBookId,
        title: title || sourceBookId,
        author,
        category: categoryName,
        downloadUrl,
        sourceUrl,
        format: 'pdb',
      });
    });

    console.log(`[haodoo] ${categoryName}: found ${books.length} books`);
    return books;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[haodoo] Error scraping category "${categoryName}" (${sourceUrl}): ${msg}`);
    return [];
  }
}

/**
 * Iterate all known categories, collect books, deduplicate by sourceBookId,
 * and optionally cap the result with `limit`.
 */
export async function discoverAll(limit?: number): Promise<HaodooBook[]> {
  const seen = new Set<string>();
  const results: HaodooBook[] = [];

  for (const { name, path } of CATEGORIES) {
    const books = await scrapeCategory(path, name);
    for (const book of books) {
      if (!seen.has(book.sourceBookId)) {
        seen.add(book.sourceBookId);
        results.push(book);
        if (limit !== undefined && results.length >= limit) {
          console.log(`[haodoo] Reached limit of ${limit} books, stopping early`);
          return results;
        }
      }
    }

    // Polite delay between category requests
    if (path !== CATEGORIES[CATEGORIES.length - 1].path) {
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  console.log(`[haodoo] discoverAll complete: ${results.length} unique books`);
  return results;
}
