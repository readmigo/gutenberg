import 'dotenv/config';
import axios from 'axios';
import { workerClient } from './lib/worker-client';

/**
 * AI Enrichment script for Gutenberg books.
 *
 * Generates AI descriptions (bilingual) and tags for books that don't have them yet.
 * Runs as a separate step, not blocking the main processing pipeline.
 *
 * Requires env vars:
 *   AI_API_URL    - OpenAI-compatible API base URL (default: https://api.deepseek.com)
 *   AI_API_KEY    - API key
 *   AI_MODEL      - Model name (default: deepseek-chat)
 */

const AI_API_URL = process.env.AI_API_URL || 'https://api.deepseek.com';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-chat';

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const LIMIT = parseInt(getArg('limit', '50'));
const DRY_RUN = args.includes('--dry-run');

const aiClient = axios.create({
  baseURL: AI_API_URL,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${AI_API_KEY}`,
  },
  timeout: 30000,
});

interface BookToEnrich {
  id: string;
  gutenberg_id: number;
  title: string;
  author: string;
  subjects: string | null;
  word_count: number;
  chapter_count: number;
  cefr_level: string | null;
}

interface EnrichmentResult {
  descriptionEn: string;
  descriptionZh: string;
  tags: string[];
  genres: string[];
}

async function generateEnrichment(book: BookToEnrich, sampleText: string): Promise<EnrichmentResult> {
  const subjects = book.subjects ? JSON.parse(book.subjects).join(', ') : 'unknown';

  const prompt = `You are a literary expert. Given a book's metadata and a sample of its text, generate:

1. A 2-3 sentence English description suitable for a reading app listing
2. A 2-3 sentence Chinese (Simplified) description of the same book
3. 3-5 topic/theme tags (in English, lowercase)
4. 1-3 genre classifications from this list: Fiction, Science Fiction, Fantasy, Mystery, Horror, Romance, Adventure, Historical Fiction, Literary Fiction, Philosophy, Science, Poetry, Drama, Biography, Humor, Children, Religion, Politics, Economics, Travel, War

Book metadata:
- Title: ${book.title}
- Author: ${book.author}
- Subjects: ${subjects}
- Word count: ${book.word_count}
- CEFR level: ${book.cefr_level || 'unknown'}

Sample text (first ~500 words):
${sampleText.slice(0, 2000)}

Respond in this exact JSON format (no markdown, no code block):
{"descriptionEn":"...","descriptionZh":"...","tags":["tag1","tag2","tag3"],"genres":["Genre1","Genre2"]}`;

  const response = await aiClient.post('/v1/chat/completions', {
    model: AI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 500,
  });

  const content = response.data.choices[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty AI response');

  // Parse JSON from response (handle potential markdown wrapping)
  let jsonStr = content;
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];

  const parsed = JSON.parse(jsonStr);
  return {
    descriptionEn: parsed.descriptionEn || '',
    descriptionZh: parsed.descriptionZh || '',
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    genres: Array.isArray(parsed.genres) ? parsed.genres : [],
  };
}

async function fetchSampleText(bookId: string): Promise<string> {
  // Fetch first chapter's content URL from Worker API
  const { data: chaptersData } = await (workerClient as any).http.get(
    `/internal/books/${bookId}/chapters`,
  );
  const chapters = Array.isArray(chaptersData) ? chaptersData : chaptersData.chapters || [];

  if (chapters.length === 0) return '';

  // Get first chapter content from R2 URL
  const firstChapter = chapters[0];
  if (!firstChapter.content_url) return '';

  try {
    const { data: html } = await axios.get(firstChapter.content_url, { timeout: 10000 });
    // Strip HTML to plain text
    return (html as string)
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);
  } catch {
    return '';
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('PG Enrich - AI Description & Tags');
  console.log(`  API: ${AI_API_URL} | Model: ${AI_MODEL}`);
  console.log(`  Limit: ${LIMIT} | Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  if (!AI_API_KEY && !DRY_RUN) {
    console.error('Error: AI_API_KEY is required for non-dry-run mode.');
    process.exit(1);
  }

  // Fetch books without AI descriptions (status ready or pending)
  console.log('\nFetching books needing enrichment...');
  let books: BookToEnrich[];
  try {
    const { data } = await (workerClient as any).http.get('/internal/books', {
      params: { status: 'ready', needs_enrichment: 'true', limit: LIMIT },
    });
    books = Array.isArray(data) ? data : data.books || [];
  } catch (err) {
    console.error('Failed to fetch books:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (books.length === 0) {
    console.log('No books need enrichment. All done!');
    return;
  }

  console.log(`Found ${books.length} book(s) to enrich.\n`);

  let enriched = 0;
  let failed = 0;

  for (const book of books) {
    console.log(`Enriching: ${book.title} (PG#${book.gutenberg_id})`);

    if (DRY_RUN) {
      console.log('  [DRY RUN] Would generate AI description and tags');
      enriched++;
      continue;
    }

    try {
      const sampleText = await fetchSampleText(book.id);
      if (!sampleText) {
        console.log('  Skipping: no chapter content available');
        failed++;
        continue;
      }

      const result = await generateEnrichment(book, sampleText);

      // Combine English and Chinese descriptions
      const description = `${result.descriptionEn}\n\n${result.descriptionZh}`;

      // Update book record in D1
      await workerClient.updateBook(book.id, {
        aiDescription: description,
        aiTags: JSON.stringify([...result.tags, ...result.genres]),
      });

      console.log(`  -> OK: ${result.tags.join(', ')} | ${result.genres.join(', ')}`);
      console.log(`  -> EN: ${result.descriptionEn.slice(0, 80)}...`);
      enriched++;

      // Rate limit: ~2 requests per second
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      failed++;
      console.error(`  -> FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Enrich Complete');
  console.log(`  Enriched: ${enriched}`);
  console.log(`  Failed:   ${failed}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Enrich failed:', err);
  process.exit(1);
});
