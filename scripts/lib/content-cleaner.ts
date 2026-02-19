// PG copyright patterns (adapted from readmigo-repos/api/src/utils/public-domain-cleaner.ts)
const GUTENBERG_PATTERNS: RegExp[] = [
  /The Project Gutenberg E[Bb]ook/i,
  /Project Gutenberg License/i,
  /www\.gutenberg\.org/i,
  /gutenberg\.org\/license/i,
  /This eBook is for the use of anyone anywhere/i,
  /SMALL PRINT!/i,
  /START OF (THIS |THE )?PROJECT GUTENBERG/i,
  /END OF (THIS |THE )?PROJECT GUTENBERG/i,
  /End of Project Gutenberg's/i,
  /\*\*\* START OF/i,
  /\*\*\* END OF/i,
  /Most people start at our Web site/i,
  /PLEASE READ THIS BEFORE YOU DISTRIBUTE/i,
  /Updated editions will replace the previous one/i,
  /You may copy it, give it away or re-use it/i,
  /Creating the works from print editions/i,
  /The Foundation's principal office is in/i,
  /Professor Michael S\. Hart was the originator/i,
  /The Project Gutenberg Literary Archive Foundation/i,
  /Volunteers and financial support/i,
  /This etext was prepared by/i,
  /Produced by/i,
  /by David Widger/i,
  /Release Date:/i,
  /Character set encoding:/i,
  /A free ebook from Project Gutenberg/i,
  /This file should be named/i,
  /If you received this eBook on a physical medium/i,
  /Transcribed from the/i,
  /Section \d+\.\s+General Information About Project Gutenberg/i,
];

// Block-level elements that may contain PG boilerplate
const BLOCK_TAGS = 'p|div|span|pre|h[1-6]|li|blockquote';

// Remove paragraphs matching PG patterns
export function cleanGutenbergContent(html: string): string {
  if (!html) return html;
  let cleaned = html;

  // Remove START/END blocks
  cleaned = cleaned.replace(/\*\*\*\s*START OF (THIS |THE )?PROJECT GUTENBERG[\s\S]*?\*\*\*/gi, '');
  cleaned = cleaned.replace(/\*\*\*\s*END OF (THIS |THE )?PROJECT GUTENBERG[\s\S]*$/gi, '');

  // Remove block-level elements containing PG patterns
  for (const pattern of GUTENBERG_PATTERNS) {
    cleaned = cleaned.replace(
      new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>[\\s\\S]*?${pattern.source}[\\s\\S]*?<\\/\\1>`, 'gi'),
      '',
    );
  }

  // Remove links to gutenberg.org
  cleaned = cleaned.replace(/<a[^>]*href="[^"]*gutenberg\.org[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '');

  // Normalize whitespace
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');
  return cleaned.trim();
}

// Remove PG inline markers like [Illustration], [Footnote], page numbers
export function removePgInlineMarkers(html: string): string {
  if (!html) return html;
  let cleaned = html;

  // [Illustration] and [Illustration: ...]
  cleaned = cleaned.replace(/\[Illustration(?::\s*[^\]]*?)?\]/gi, '');

  // [Footnote: ...]
  cleaned = cleaned.replace(/\[Footnote:\s*[^\]]*?\]/gi, '');

  // Page number markers: [pg 42], [p. 42], {42}
  cleaned = cleaned.replace(/\[pg?\.\s*\d+\]/gi, '');
  cleaned = cleaned.replace(/\{\d+\}/g, '');

  return cleaned;
}

// Remove dead links to endnote/footnote chapters (which are skipped by epub-parser)
export function removeEndnoteLinks(html: string): string {
  if (!html) return html;
  // Keep link text, remove the <a> wrapper for endnote/footnote hrefs
  return html.replace(
    /<a\b[^>]*href=["'][^"']*(?:endnote|footnote|#fn|#note|#ref)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
    '$1',
  );
}

// General HTML cleanup
export function cleanChapterHtml(html: string): string {
  if (!html) return html;
  let cleaned = html;

  // Remove scripts and styles
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // Clean PG content
  cleaned = cleanGutenbergContent(cleaned);

  // Remove PG inline markers
  cleaned = removePgInlineMarkers(cleaned);

  // Remove dead endnote/footnote links
  cleaned = removeEndnoteLinks(cleaned);

  return cleaned.trim();
}
