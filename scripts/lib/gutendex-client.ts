import axios from 'axios';

const BASE_URL = process.env.GUTENDEX_BASE_URL || 'https://gutendex.com';

export interface GutendexBook {
  id: number;
  title: string;
  authors: Array<{ name: string; birth_year: number | null; death_year: number | null }>;
  subjects: string[];
  bookshelves: string[];
  languages: string[];
  formats: Record<string, string>;
  download_count: number;
  media_type: string;
}

interface GutendexResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: GutendexBook[];
}

export async function fetchPage(page: number, languages = 'en'): Promise<GutendexResponse> {
  const { data } = await axios.get<GutendexResponse>(`${BASE_URL}/books/`, {
    params: { languages, mime_type: 'application/epub+zip', page },
    timeout: 120000,
  });
  return data;
}

export function getEpubUrl(book: GutendexBook): string | null {
  return book.formats['application/epub+zip'] || book.formats['application/epub'] || null;
}

export async function fetchBookById(id: number): Promise<GutendexBook | null> {
  // Gutendex added a 301 redirect to the trailing-slash form; use it directly
  // to avoid an extra round-trip on every call.
  const url = `${BASE_URL}/books/${id}/`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await axios.get<GutendexBook>(url, {
        timeout: 30000,
        maxRedirects: 5,
      });
      return data;
    } catch (err: any) {
      // Genuine "not found" — book removed upstream. Return null so the
      // caller can mark this job as unrecoverable.
      if (err?.response?.status === 404) return null;
      // Anything else (timeouts, 5xx, DNS, socket hang-up, proxy issues) is
      // transient. Back off and retry; only give up after the last attempt.
      lastErr = err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  // Throw the last error so upstream can distinguish this from a clean 404.
  // Without this, silent failures get mislabelled as "Book not found" and
  // we lose the ability to retry transient network problems.
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Gutendex fetch failed for id=${id}: ${msg}`);
}
