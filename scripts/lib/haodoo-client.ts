import axios from 'axios';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.haodoo.net';
const USER_AGENT = 'Readmigo-Bot/1.0 (book pipeline)';

export interface HaodooBook {
  sourceBookId: string;  // numeric ID from ?M=book&P={id}
  title: string;
  author: string;
  category: string;
  downloadUrl: string;   // direct EPUB download URL
  sourceUrl: string;     // book page URL
  format: 'epub';
}

/**
 * Haodoo category pages use query params, not path segments.
 * URL pattern: https://www.haodoo.net/?M=hd&P={category}
 *
 * Listing page HTML structure:
 *   <font color="CC0000">作者名</font><a href="?M=book&P=394">【書名】</a>
 *
 * EPUB download URL is derived from book ID:
 *   DownloadEpub('A{id}') → /PDB/A/{id}.epub
 *   (d.js: $book.substring(0,1) + "/" + $book.substring(1) + ".epub")
 */
const CATEGORIES: Array<{ name: string; param: string }> = [
  { name: '世纪百强', param: '100' },
  { name: '武侠小说', param: 'martial' },
  { name: '言情小说', param: 'romance' },
  { name: '推理小说', param: 'mystery' },
  { name: '奇幻小说', param: 'scifi' },
  { name: '历史烟云', param: 'history' },
  { name: '随身智囊', param: 'wisdom' },
  { name: '小说园地', param: 'fiction' },
];

/** Strip bracket characters from title: 【】《》 */
function cleanTitle(raw: string): string {
  return raw.replace(/[【】《》\[\]]/g, '').trim();
}

/** Build direct EPUB download URL from book page ID.
 *  Haodoo d.js convention: DownloadEpub('A{id}') → /PDB/A/{id}.epub */
function buildEpubUrl(bookId: string): string {
  return `${BASE_URL}/PDB/A/${bookId}.epub`;
}

/**
 * Scrape a single category listing page.
 *
 * HTML pattern on listing pages:
 *   <font color="CC0000">魯迅</font><a href="?M=book&P=435">【吶喊】</a><br>
 *   <a href="?M=book&P=394">【邊城】</a><br>    ← author from preceding <font>
 *
 * Strategy: find all <a> tags linking to ?M=book&P={id}, extract title from
 * link text, extract author from the preceding <font color="CC0000"> sibling.
 */
export async function scrapeCategory(
  categoryParam: string,
  categoryName: string,
): Promise<HaodooBook[]> {
  const sourceUrl = `${BASE_URL}/?M=hd&P=${categoryParam}`;
  try {
    const { data: html } = await axios.get<string>(sourceUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 30_000,
      maxRedirects: 5,
    });

    const books: HaodooBook[] = [];

    // The HTML mixes <font color="CC0000">Author</font> and
    // <a href="?M=book&P=id">Title</a> as siblings in document order.
    // Sometimes the author font is on its own line before the book link.
    // Use regex to extract ordered events from raw HTML for reliable parsing.
    const events: Array<
      | { type: 'author'; name: string; pos: number }
      | { type: 'book'; id: string; title: string; pos: number }
    > = [];

    const fontRegex = /<font\s+color="[Cc][Cc]0000">([^<]+)<\/font>/g;
    const linkRegex = /<a[^>]+href="[^"]*[?&]M=book&P=(\d+)"[^>]*>([^<]+)<\/a>/g;

    let m: RegExpExecArray | null;
    while ((m = fontRegex.exec(html)) !== null) {
      const name = m[1].trim();
      if (name && !name.includes('搜尋') && !name.includes('Google') && name.length < 20) {
        events.push({ type: 'author', name, pos: m.index });
      }
    }
    while ((m = linkRegex.exec(html)) !== null) {
      events.push({ type: 'book', id: m[1], title: cleanTitle(m[2]), pos: m.index });
    }

    // Sort by position in HTML to preserve document order
    events.sort((a, b) => a.pos - b.pos);

    let lastAuthor = '未知';
    for (const evt of events) {
      if (evt.type === 'author') {
        lastAuthor = evt.name;
      } else {
        if (!evt.title) continue;
        books.push({
          sourceBookId: evt.id,
          title: evt.title,
          author: lastAuthor,
          category: categoryName,
          downloadUrl: buildEpubUrl(evt.id),
          sourceUrl: `${BASE_URL}/?M=book&P=${evt.id}`,
          format: 'epub',
        });
      }
    }

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

  for (const { name, param } of CATEGORIES) {
    const books = await scrapeCategory(param, name);
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
    await new Promise((r) => setTimeout(r, 2_000));
  }

  console.log(`[haodoo] discoverAll complete: ${results.length} unique books`);
  return results;
}
