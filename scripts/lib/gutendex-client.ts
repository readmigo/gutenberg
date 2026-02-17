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
  const { data } = await axios.get<GutendexResponse>(`${BASE_URL}/books`, {
    params: { languages, mime_type: 'application/epub+zip', page },
    timeout: 30000,
  });
  return data;
}

export function getEpubUrl(book: GutendexBook): string | null {
  return book.formats['application/epub+zip'] || book.formats['application/epub'] || null;
}

export async function fetchBookById(id: number): Promise<GutendexBook | null> {
  try {
    const { data } = await axios.get<GutendexBook>(`${BASE_URL}/books/${id}`, { timeout: 15000 });
    return data;
  } catch {
    return null;
  }
}
