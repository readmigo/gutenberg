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
