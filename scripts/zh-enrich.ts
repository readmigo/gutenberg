import 'dotenv/config';
import axios from 'axios';
import { workerClient } from './lib/worker-client';
import { initJieba, analyzeZhDifficulty } from './lib/zh-difficulty';
import { generateCoverPrompt } from './lib/cover-prompt';

/**
 * Metadata enrichment script for Chinese books.
 *
 * Enriches books with:
 * - Dynasty detection (from author/title keyword matching)
 * - Difficulty analysis (HSK level + difficulty score via jieba-wasm)
 * - Cover prompt generation (if no cover_url)
 *
 * CLI args:
 *   --limit=N   Max books to process (default: 50)
 *
 * Required env vars:
 *   WORKER_BASE_URL      - Worker API base URL
 *   WORKER_INTERNAL_KEY  - Internal auth key
 *   R2_PUBLIC_URL        - Public base URL for R2 assets (for resolving relative content URLs)
 */

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : def;
};

const LIMIT = parseInt(getArg('limit', '50'), 10);

const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Dynasty keyword map
// ---------------------------------------------------------------------------

const DYNASTY_KEYWORDS: Array<{ keywords: string[]; dynasty: string }> = [
  { keywords: ['孔子', '孟子', '老子', '庄子', '荀子', '韩非', '孙武', '墨子'], dynasty: '先秦' },
  { keywords: ['司马迁', '刘安', '班固'], dynasty: '两汉' },
  { keywords: ['曹操', '曹植', '陶渊明', '刘义庆'], dynasty: '魏晋南北朝' },
  { keywords: ['李白', '杜甫', '白居易', '韩愈', '柳宗元', '王维'], dynasty: '唐' },
  { keywords: ['苏轼', '欧阳修', '辛弃疾', '李清照', '司马光', '朱熹'], dynasty: '宋' },
  { keywords: ['关汉卿', '马致远'], dynasty: '元' },
  { keywords: ['罗贯中', '施耐庵', '吴承恩', '冯梦龙', '凌濛初', '吴敬梓', '曹雪芹', '蒲松龄'], dynasty: '明' },
  { keywords: ['纪昀', '李汝珍', '刘鹗', '曾国藩', '李宝嘉'], dynasty: '清' },
  { keywords: ['鲁迅', '胡适', '老舍', '梁启超', '林语堂', '郁达夫', '朱自清'], dynasty: '民国' },
];

/**
 * Detect dynasty from author name and book title using keyword matching.
 * Returns undefined if no match found.
 */
function detectDynasty(author: string, title: string): string | undefined {
  const haystack = `${author} ${title}`;
  for (const { keywords, dynasty } of DYNASTY_KEYWORDS) {
    for (const kw of keywords) {
      if (haystack.includes(kw)) {
        return dynasty;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ZhBook {
  id: string;
  title: string;
  author: string;
  cover_url?: string | null;
  source_id?: string;
  subjects?: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Chapter content fetching
// ---------------------------------------------------------------------------

/**
 * Resolve a potentially relative content URL to an absolute URL.
 */
function resolveContentUrl(contentUrl: string): string {
  if (contentUrl.startsWith('http://') || contentUrl.startsWith('https://')) {
    return contentUrl;
  }
  // Relative path — prepend R2 public base URL
  const path = contentUrl.startsWith('/') ? contentUrl : `/${contentUrl}`;
  return `${R2_PUBLIC_URL}${path}`;
}

/**
 * Fetch sample text from the first chapter of a book.
 * Returns empty string if unavailable.
 */
async function fetchSampleText(bookId: string): Promise<string> {
  try {
    const { data: chaptersData } = await (workerClient as any).http.get(
      `/internal/books/${bookId}/chapters`,
    );
    const chapters = Array.isArray(chaptersData)
      ? chaptersData
      : chaptersData.chapters || [];

    if (chapters.length === 0) return '';

    const firstChapter = chapters[0];
    const rawUrl: string | undefined = firstChapter.content_url || firstChapter.contentUrl;
    if (!rawUrl) return '';

    const absoluteUrl = resolveContentUrl(rawUrl);

    const { data: html } = await axios.get(absoluteUrl, { timeout: 10000 });
    const text = (html as string)
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/&#\d+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, 3000);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60));
  console.log('ZH Enrich - Dynasty / Difficulty / Cover Prompt');
  console.log(`  Limit: ${LIMIT}`);
  console.log('='.repeat(60));

  // 1. Init jieba
  console.log('\nInitializing jieba-wasm...');
  await initJieba();
  console.log('  jieba ready.');

  // 2. Fetch pending Chinese books
  console.log('\nFetching pending Chinese books...');
  let books: ZhBook[];
  try {
    const { data } = await (workerClient as any).http.get('/api/zh/books', {
      params: { status: 'pending', limit: LIMIT },
    });
    books = Array.isArray(data) ? data : data.books || [];
  } catch (err) {
    console.error('Failed to fetch books:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (books.length === 0) {
    console.log('No pending books found. All done!');
    return;
  }

  console.log(`Found ${books.length} book(s) to enrich.\n`);

  let enriched = 0;
  let failed = 0;

  for (const book of books) {
    console.log(`Processing: ${book.title} / ${book.author} [${book.id}]`);

    try {
      // a. Dynasty detection
      const dynasty = detectDynasty(book.author || '', book.title || '');
      if (dynasty) {
        console.log(`  dynasty: ${dynasty}`);
      } else {
        console.log(`  dynasty: (no match)`);
      }

      // b. Fetch sample text from first chapter
      const sampleText = await fetchSampleText(book.id);
      if (!sampleText) {
        console.log('  sample text: (unavailable)');
      } else {
        console.log(`  sample text: ${sampleText.length} chars`);
      }

      // c. Run difficulty analysis
      let hskLevel = 4;
      let difficultyScore = 50;

      if (sampleText) {
        const result = analyzeZhDifficulty(sampleText);
        hskLevel = result.hskLevel;
        difficultyScore = result.difficultyScore;
        console.log(`  difficulty: HSK ${hskLevel}, score ${difficultyScore}`);
      } else {
        console.log(`  difficulty: (skipped — no sample text)`);
      }

      // d. Generate cover prompt if no cover_url
      let coverPrompt: string | undefined;
      if (!book.cover_url) {
        const subjects = book.subjects
          ? (() => {
              try { return JSON.parse(book.subjects!); } catch { return undefined; }
            })()
          : undefined;

        coverPrompt = generateCoverPrompt({
          title: book.title,
          author: book.author,
          dynasty,
          subjects: Array.isArray(subjects) ? subjects : undefined,
          language: 'zh',
        });
        console.log(`  cover prompt: generated (${coverPrompt.length} chars)`);
      } else {
        console.log(`  cover prompt: (skipped — cover_url exists)`);
      }

      // e. Update book via PATCH /api/zh/books/{id}
      const bookPatch: Record<string, unknown> = {
        dynasty,
        hskLevel,
        difficultyScore,
        status: 'enriched',
      };
      if (coverPrompt !== undefined) {
        bookPatch.coverPrompt = coverPrompt;
      }

      await (workerClient as any).http.patch(`/api/zh/books/${book.id}`, bookPatch);
      console.log(`  -> book updated`);

      // f. Update source via PUT /api/zh/sources/{id} if source_id is available
      if (book.source_id) {
        await (workerClient as any).http.put(`/api/zh/sources/${book.source_id}`, {
          status: 'enriched',
        });
        console.log(`  -> source updated`);
      }

      enriched++;
    } catch (err) {
      failed++;
      console.error(`  -> FAILED: ${err instanceof Error ? err.message : err}`);
    }

    console.log('');
  }

  console.log('='.repeat(60));
  console.log('ZH Enrich Complete');
  console.log(`  Enriched: ${enriched}`);
  console.log(`  Failed:   ${failed}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('ZH Enrich failed:', err);
  process.exit(1);
});
