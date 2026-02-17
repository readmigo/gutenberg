import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const BUCKET = process.env.R2_BUCKET_NAME || 'gutenberg-production';
const PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

export async function uploadToR2(key: string, body: Buffer | string, contentType: string): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: typeof body === 'string' ? Buffer.from(body, 'utf-8') : body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000',
    }),
  );
  return `${PUBLIC_URL}/${key}`;
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
