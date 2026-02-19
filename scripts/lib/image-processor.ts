/**
 * Image processor for EPUB inline illustrations (Gap 3.6).
 *
 * Handles:
 * 1. Extracting [Illustration: caption] text before PG markers are removed
 * 2. Rewriting dead <img src="/images/..."> paths to live R2 URLs
 * 3. Applying extracted captions as alt text on nearby <img> tags
 * 4. Extracting and rewriting base64 data URI images
 */

import * as path from 'path';

// ─── Caption Extraction ────────────────────────────────────────────────────────

/**
 * Extract illustration captions from PG [Illustration: ...] markers.
 * Must be called BEFORE content-cleaner removes these markers.
 * Returns captions in order of appearance.
 */
export function extractIllustrationCaptions(html: string): string[] {
  const captions: string[] = [];
  const re = /\[Illustration:\s*([^\]]+)\]/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    captions.push(match[1].trim());
  }
  return captions;
}

// ─── Image Path Mapping ────────────────────────────────────────────────────────

/**
 * Build a mapping from epub2-rewritten image paths to R2 URLs.
 *
 * epub2's getChapter() rewrites image src as: url.resolve("/images/", joinedPath)
 * where joinedPath = posix.join(chapterBasePath, originalSrc).
 * This results in paths like "/images/OEBPS/images/figure1.jpg".
 *
 * We map from the image's manifest href (which is the canonical path within the EPUB)
 * to its R2 URL, then match against src attributes containing that href.
 */
export function buildImageMap(
  images: Array<{ href: string; r2Url: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const img of images) {
    // The epub2-rewritten src will contain the manifest href path
    // Map both the full /images/ prefixed path and just the href
    map.set(`/images/${img.href}`, img.r2Url);
    map.set(img.href, img.r2Url);
    // Also map the decoded version (epub2 may use encoded/decoded variants)
    const decoded = decodeURIComponent(img.href);
    if (decoded !== img.href) {
      map.set(`/images/${decoded}`, img.r2Url);
      map.set(decoded, img.r2Url);
    }
  }
  return map;
}

// ─── Image Path Rewriting ──────────────────────────────────────────────────────

/**
 * Rewrite <img src="..."> attributes in chapter HTML to point to R2 URLs.
 * Also applies illustration captions as alt text where missing.
 */
export function rewriteImagePaths(
  html: string,
  imageMap: Map<string, string>,
  captions: string[] = [],
): string {
  let captionIdx = 0;

  return html.replace(
    /<img\b([^>]*?)>/gi,
    (match: string, attrs: string) => {
      // Extract current src
      const srcMatch = attrs.match(/src\s*=\s*["']([^"']*?)["']/i);
      if (!srcMatch) return match;

      const originalSrc = srcMatch[1];
      let newSrc = originalSrc;

      // Try exact match first, then partial match
      if (imageMap.has(originalSrc)) {
        newSrc = imageMap.get(originalSrc)!;
      } else {
        // Try matching by finding the image href within the src
        for (const [pattern, r2Url] of imageMap) {
          if (originalSrc.includes(pattern) || originalSrc.endsWith(pattern)) {
            newSrc = r2Url;
            break;
          }
        }
      }

      // Build new attributes with updated src
      let newAttrs = attrs.replace(
        /src\s*=\s*["'][^"']*?["']/i,
        `src="${newSrc}"`,
      );

      // Add alt text from captions if missing or empty
      const hasAlt = /alt\s*=\s*["'][^"']+["']/i.test(newAttrs);
      if (!hasAlt && captionIdx < captions.length) {
        const caption = captions[captionIdx++];
        if (/alt\s*=\s*["']\s*["']/i.test(newAttrs)) {
          // Replace empty alt with caption
          newAttrs = newAttrs.replace(/alt\s*=\s*["']\s*["']/i, `alt="${escapeAttr(caption)}"`);
        } else if (!/alt\s*=/i.test(newAttrs)) {
          // No alt attribute at all — add one
          newAttrs = newAttrs.trimEnd() + ` alt="${escapeAttr(caption)}"`;
        }
      }

      return `<img${newAttrs}>`;
    },
  );
}

// ─── Base64 Image Extraction ───────────────────────────────────────────────────

export interface ExtractedBase64Image {
  index: number;
  data: Buffer;
  mimeType: string;
  filename: string;
}

/**
 * Extract base64 data URI images from HTML and return them for upload.
 * Replaces data URIs with placeholder tokens that should be replaced with R2 URLs.
 */
export function extractBase64Images(html: string): {
  cleanedHtml: string;
  images: ExtractedBase64Image[];
} {
  const images: ExtractedBase64Image[] = [];
  let idx = 0;

  const cleanedHtml = html.replace(
    /src\s*=\s*["'](data:image\/([^;]+);base64,([^"']+))["']/gi,
    (_match: string, _fullUri: string, format: string, base64Data: string) => {
      const ext = format === 'jpeg' ? 'jpg' : format;
      const filename = `inline-${idx}.${ext}`;
      images.push({
        index: idx,
        data: Buffer.from(base64Data, 'base64'),
        mimeType: `image/${format}`,
        filename,
      });
      const placeholder = `src="__BASE64_IMAGE_${idx}__"`;
      idx++;
      return placeholder;
    },
  );

  return { cleanedHtml, images };
}

/**
 * Replace base64 image placeholders with R2 URLs.
 */
export function replaceBase64Placeholders(
  html: string,
  urlMap: Map<number, string>,
): string {
  return html.replace(
    /src="__BASE64_IMAGE_(\d+)__"/g,
    (_match: string, idx: string) => {
      const url = urlMap.get(parseInt(idx, 10));
      return url ? `src="${url}"` : _match;
    },
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Get a clean filename from an EPUB image href.
 * Extracts the basename and sanitizes it for use as an R2 key.
 */
export function getImageFilename(href: string): string {
  const basename = path.posix.basename(href);
  // Sanitize: keep only alphanumeric, dots, hyphens, underscores
  return basename.replace(/[^a-zA-Z0-9.\-_]/g, '_') || 'image.bin';
}
