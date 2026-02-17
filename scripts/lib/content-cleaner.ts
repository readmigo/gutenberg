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
];

// Remove paragraphs matching PG patterns
export function cleanGutenbergContent(html: string): string {
  if (!html) return html;
  let cleaned = html;

  // Remove START/END blocks
  cleaned = cleaned.replace(/\*\*\*\s*START OF (THIS |THE )?PROJECT GUTENBERG[\s\S]*?\*\*\*/gi, '');
  cleaned = cleaned.replace(/\*\*\*\s*END OF (THIS |THE )?PROJECT GUTENBERG[\s\S]*$/gi, '');

  // Remove paragraphs containing PG patterns
  for (const pattern of GUTENBERG_PATTERNS) {
    cleaned = cleaned.replace(new RegExp(`<p[^>]*>[^<]*?${pattern.source}[\\s\\S]*?<\\/p>`, 'gi'), '');
  }

  // Remove links to gutenberg.org
  cleaned = cleaned.replace(/<a[^>]*href="[^"]*gutenberg\.org[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '');

  // Normalize whitespace
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');
  return cleaned.trim();
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

  return cleaned.trim();
}
