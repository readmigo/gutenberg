import axios from 'axios';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.wenshuoge.com';
const USER_AGENT = 'Readmigo-Bot/1.0 (book pipeline)';
const REQUEST_DELAY_MS = 2000;

const DYNASTY_PATHS: Array<{ name: string; path: string }> = [
  { name: '先秦', path: '/xianqin' },
  { name: '两汉', path: '/lianghan' },
  { name: '魏晋南北朝', path: '/weijin' },
  { name: '唐', path: '/tang' },
  { name: '宋', path: '/song' },
  { name: '元', path: '/yuan' },
  { name: '明', path: '/ming' },
  { name: '清', path: '/qing' },
  { name: '近代', path: '/jindai' },
];

export interface WenshuogeBook {
  sourceBookId: string;
  title: string;
  author: string;
  dynasty: string;
  category: string;
  downloadUrl: string;
  sourceUrl: string;
  format: 'epub' | 'txt';
}

/**
 * Derive a stable sourceBookId from a URL.
 * Uses the last meaningful path segment or query string.
 */
function deriveBookId(url: string): string {
  try {
    const parsed = new URL(url, BASE_URL);
    // e.g. /book/12345.epub → "12345"
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    const withoutExt = last.replace(/\.(epub|txt)$/i, '');
    if (withoutExt) return withoutExt;
    // fallback: strip protocol+host
    return parsed.pathname.replace(/\//g, '-').replace(/^-/, '');
  } catch {
    return url.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').slice(0, 80);
  }
}

/**
 * Resolve a potentially relative URL to an absolute one.
 */
function resolveUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}

/**
 * Scrape a single dynasty catalog page and return all discovered books.
 *
 * NOTE: Selectors are based on common patterns observed on wenshuoge.com and
 * may need adjustment after live testing. The current strategy:
 *   1. Find any <a> whose href ends in .epub or .txt (direct download links).
 *   2. Also check links with "download" in href as a fallback.
 *   3. Prefer .epub over .txt when both formats appear for the same book.
 */
export async function scrapeDynasty(
  dynastyPath: string,
  dynastyName: string,
): Promise<WenshuogeBook[]> {
  const pageUrl = `${BASE_URL}${dynastyPath}`;
  let html: string;

  try {
    const { data } = await axios.get<string>(pageUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 30_000,
      responseType: 'text',
    });
    html = data;
  } catch (err: any) {
    console.error(
      `[wenshuoge] Failed to fetch dynasty page ${dynastyPath}: ${err?.message ?? err}`,
    );
    return [];
  }

  const $ = cheerio.load(html);

  // Map from sourceBookId → best candidate so far (epub wins over txt)
  const candidates = new Map<string, WenshuogeBook>();

  // Primary selector: direct .epub / .txt download links
  // Fallback selector: links containing "download" in href
  const linkSelector = [
    'a[href$=".epub"]',
    'a[href$=".txt"]',
    'a[href*="download"]',
  ].join(', ');

  $(linkSelector).each((_i, el) => {
    const $el = $(el);
    const rawHref = $el.attr('href')?.trim();
    if (!rawHref) return;

    // Determine format
    let format: 'epub' | 'txt' | null = null;
    if (/\.epub$/i.test(rawHref)) format = 'epub';
    else if (/\.txt$/i.test(rawHref)) format = 'txt';
    else {
      // "download" link — try to infer from text or href content
      const text = $el.text().toLowerCase();
      if (text.includes('epub') || rawHref.toLowerCase().includes('epub')) format = 'epub';
      else if (text.includes('txt') || rawHref.toLowerCase().includes('txt')) format = 'txt';
      else return; // can't determine format, skip
    }

    const downloadUrl = resolveUrl(rawHref);
    const sourceBookId = deriveBookId(rawHref);

    // Extract title: try the link text, then a nearby heading, then a title attribute
    let title =
      $el.attr('title')?.trim() ||
      $el.text().trim() ||
      $el.closest('[class*="book"], [class*="item"], li, tr').find('h2, h3, h4, .title, .name').first().text().trim() ||
      '';

    // Strip format suffixes from title (e.g. "红楼梦 EPUB")
    title = title.replace(/\s*(epub|txt)\s*$/i, '').trim();

    if (!title) {
      // Derive from the file name as last resort
      const fileName = rawHref.split('/').pop() ?? '';
      title = decodeURIComponent(fileName.replace(/\.(epub|txt)$/i, ''));
    }

    // Extract author: look for adjacent author metadata
    const $row = $el.closest('[class*="book"], [class*="item"], li, tr');
    const author =
      $row.find('[class*="author"], .zuozhe, .writer').first().text().trim() ||
      $row.find('span, td').filter((_j, span) => /作者/.test($(span).text())).first().text()
        .replace(/作者[：:]\s*/u, '').trim() ||
      '';

    // Extract category from sibling metadata
    const category =
      $row.find('[class*="categ"], [class*="type"], .leibie').first().text().trim() || '';

    const book: WenshuogeBook = {
      sourceBookId,
      title,
      author,
      dynasty: dynastyName,
      category,
      downloadUrl,
      sourceUrl: pageUrl,
      format,
    };

    const existing = candidates.get(sourceBookId);
    if (!existing || (format === 'epub' && existing.format === 'txt')) {
      // epub preferred over txt; otherwise first-wins
      candidates.set(sourceBookId, book);
    }
  });

  const books = Array.from(candidates.values());
  console.log(`[wenshuoge] ${dynastyName} (${dynastyPath}): found ${books.length} books`);
  return books;
}

/**
 * Iterate all dynasty catalog pages with a 2-second inter-request delay,
 * deduplicate by sourceBookId (epub preferred), and apply an optional limit.
 */
export async function discoverAll(limit?: number): Promise<WenshuogeBook[]> {
  const seen = new Map<string, WenshuogeBook>();

  for (let i = 0; i < DYNASTY_PATHS.length; i++) {
    const { name, path } = DYNASTY_PATHS[i];
    const books = await scrapeDynasty(path, name);

    for (const book of books) {
      const existing = seen.get(book.sourceBookId);
      if (!existing || (book.format === 'epub' && existing.format === 'txt')) {
        seen.set(book.sourceBookId, book);
      }
    }

    if (limit !== undefined && seen.size >= limit) break;

    // Delay between dynasty page requests (skip delay after last page)
    if (i < DYNASTY_PATHS.length - 1) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  let results = Array.from(seen.values());
  if (limit !== undefined) results = results.slice(0, limit);

  console.log(`[wenshuoge] discoverAll: ${results.length} unique books`);
  return results;
}
