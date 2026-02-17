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

// Detect license/colophon chapters to skip
function isSkippableChapter(title: string, href?: string): boolean {
  const lower = (title || '').toLowerCase();
  const lowerHref = (href || '').toLowerCase();
  const skipKeywords = [
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
  return (
    skipKeywords.some((kw) => lower.includes(kw)) ||
    lowerHref.includes('cover') ||
    lowerHref.includes('titlepage')
  );
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

// Extract chapters from EPUB
export async function extractChapters(epub: any): Promise<ParsedChapter[]> {
  const chapters: ParsedChapter[] = [];
  const toc = epub.toc || [];
  const flow = epub.flow || [];
  const items = toc.length > 0 ? toc : flow;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const title = item.title?.trim() || `Chapter ${i + 1}`;

    if (isSkippableChapter(title, item.href)) continue;

    const baseHref = (item.href || '').split('#')[0];
    const flowItem = flow.find((f: any) => f.href === baseHref || f.href?.endsWith(baseHref));
    let content = '';

    if (flowItem) {
      content = await getChapterContent(epub, flowItem.id);
    }

    if (!content || content.length < 100) continue;

    const wordCount = countWords(stripHtml(content));
    chapters.push({
      order: chapters.length + 1,
      title,
      href: item.href || '',
      htmlContent: content,
      wordCount,
    });
  }

  return chapters;
}
