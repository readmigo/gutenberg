import axios from 'axios';

const AI_API_URL = process.env.AI_API_URL || 'https://api.deepseek.com';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-chat';

const PUNCTUATION_RE = /[，。！？、；：""''（）《》【】…—·.,!?;:"'()]/g;
const CHUNK_SIZE = 2000;
const PUNCTUATION_THRESHOLD = 0.02; // 2%

/**
 * Returns true if the text likely needs punctuation added.
 * Only checks texts >= 100 characters. Returns false for shorter texts.
 * A text "needs punctuation" when punctuation characters make up < 2% of total chars.
 */
export function needsPunctuation(text: string): boolean {
  if (text.length < 100) return false;
  const matches = text.match(PUNCTUATION_RE);
  const punctCount = matches ? matches.length : 0;
  return punctCount / text.length < PUNCTUATION_THRESHOLD;
}

/**
 * Adds modern punctuation to classical Chinese text via LLM.
 * Chunks the text at 2000 characters, calls the LLM for each chunk,
 * and waits 1 second between chunks to avoid rate limiting.
 * On any failure, logs the error and returns the original text unchanged.
 */
export async function addPunctuation(text: string): Promise<string> {
  const aiClient = axios.create({
    baseURL: AI_API_URL,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    timeout: 60000,
  });

  const systemPrompt =
    '你是一位古文标点专家。请为以下古文添加现代标点符号（句号、逗号、问号、感叹号、顿号、分号等）。只添加标点，不要修改原文的任何文字。不要添加任何解释，直接返回标点后的文本。';

  // Split into chunks of CHUNK_SIZE characters
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }

  const results: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    try {
      const response = await aiClient.post('/v1/chat/completions', {
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: chunk },
        ],
        temperature: 0.1,
      });

      const content = response.data.choices?.[0]?.message?.content?.trim();
      if (!content) {
        console.error(`[zh-punctuation] Empty response for chunk ${i + 1}/${chunks.length}`);
        return text;
      }

      results.push(content);
    } catch (err) {
      console.error(
        `[zh-punctuation] Failed on chunk ${i + 1}/${chunks.length}:`,
        err instanceof Error ? err.message : err,
      );
      return text;
    }

    // 1-second delay between chunks (skip after last chunk)
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return results.join('');
}
