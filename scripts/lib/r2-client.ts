import axios from 'axios';
import 'dotenv/config';

const BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:8787';
const INTERNAL_KEY = process.env.WORKER_INTERNAL_KEY || '';
const PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

async function uploadToR2(key: string, body: Buffer | string, contentType: string): Promise<string> {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;

  await axios.put(`${BASE_URL}/internal/r2/${key}`, data, {
    headers: {
      'X-Internal-Key': INTERNAL_KEY,
      'Content-Type': contentType,
    },
    timeout: 120000,
    maxBodyLength: 100 * 1024 * 1024,
  });

  return PUBLIC_URL ? `${PUBLIC_URL}/${key}` : key;
}

export async function uploadEpub(gutenbergId: number, buffer: Buffer): Promise<string> {
  return uploadToR2(`books/${gutenbergId}/original.epub`, buffer, 'application/epub+zip');
}

export async function uploadCover(gutenbergId: number, buffer: Buffer, mimeType: string): Promise<string> {
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  return uploadToR2(`books/${gutenbergId}/cover.${ext}`, buffer, mimeType);
}

export async function uploadChapter(gutenbergId: number, chapterId: string, html: string): Promise<string> {
  return uploadToR2(`books/${gutenbergId}/chapters/${chapterId}.html`, html, 'text/html; charset=utf-8');
}

export async function uploadImage(gutenbergId: number, filename: string, buffer: Buffer, mimeType: string): Promise<string> {
  return uploadToR2(`books/${gutenbergId}/images/${filename}`, buffer, mimeType);
}
