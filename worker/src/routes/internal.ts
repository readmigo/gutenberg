import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, inArray } from 'drizzle-orm';
import { books, chapters, processJobs } from '../db/schema';
import { internalAuth } from '../middleware/auth';
import type { Env } from '../index';

export const internalRoutes = new Hono<Env>();

// Apply internalAuth to all routes in this group
internalRoutes.use('*', internalAuth);

// Global error handler for internal routes
internalRoutes.onError((err, c) => {
  console.error('Internal route error:', err.message, err.stack);
  return c.json({ error: err.message }, 500);
});

// POST /books - Create a book record
internalRoutes.post('/books', async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json();

  await db.insert(books).values({
    id: body.id,
    gutenbergId: body.gutenbergId,
    title: body.title,
    author: body.author,
    language: body.language,
    subjects: body.subjects,
    bookshelves: body.bookshelves,
    description: body.description,
    wordCount: body.wordCount,
    chapterCount: body.chapterCount,
    coverUrl: body.coverUrl,
    epubUrl: body.epubUrl,
    sourceUrl: body.sourceUrl,
    status: body.status ?? 'pending',
    qualityScore: body.qualityScore,
    qualityIssues: body.qualityIssues,
  });

  const created = await db.select().from(books).where(eq(books.id, body.id)).get();
  return c.json(created, 201);
});

// PUT /books/:id - Update book fields
internalRoutes.put('/books/:id', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');
  const body = await c.req.json();

  const now = new Date().toISOString();
  await db
    .update(books)
    .set({ ...body, updatedAt: now })
    .where(eq(books.id, id));

  return c.json({ message: 'Updated' });
});

// POST /books/:id/chapters - Batch create chapters
internalRoutes.post('/books/:id/chapters', async (c) => {
  const db = drizzle(c.env.DB);
  const bookId = c.req.param('id');
  const body = await c.req.json<{
    chapters: Array<{
      id: string;
      orderNum: number;
      title: string;
      contentUrl?: string;
      wordCount?: number;
      qualityOk?: number;
    }>;
  }>();

  if (!body.chapters || !Array.isArray(body.chapters) || body.chapters.length === 0) {
    return c.json({ error: 'chapters array is required' }, 400);
  }

  const values = body.chapters.map((ch) => ({
    id: ch.id,
    bookId,
    orderNum: ch.orderNum,
    title: ch.title,
    contentUrl: ch.contentUrl,
    wordCount: ch.wordCount ?? 0,
    qualityOk: ch.qualityOk ?? 1,
  }));

  await db.insert(chapters).values(values);

  return c.json({ created: values.length }, 201);
});

// PUT /jobs/:id - Update job
internalRoutes.put('/jobs/:id', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');
  const body = await c.req.json();

  const updateFields: Record<string, unknown> = {};
  if (body.status !== undefined) updateFields.status = body.status;
  if (body.stepDetail !== undefined) updateFields.stepDetail = body.stepDetail;
  if (body.attempts !== undefined) updateFields.attempts = body.attempts;
  if (body.errorMessage !== undefined) updateFields.errorMessage = body.errorMessage;
  if (body.startedAt !== undefined) updateFields.startedAt = body.startedAt;
  if (body.completedAt !== undefined) updateFields.completedAt = body.completedAt;

  await db
    .update(processJobs)
    .set(updateFields)
    .where(eq(processJobs.id, id));

  return c.json({ message: 'Updated' });
});

// GET /jobs - Pull jobs
internalRoutes.get('/jobs', async (c) => {
  const db = drizzle(c.env.DB);
  const status = c.req.query('status') ?? 'queued';
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 1));

  const data = await db
    .select()
    .from(processJobs)
    .where(eq(processJobs.status, status))
    .orderBy(desc(processJobs.priority))
    .limit(limit);

  return c.json(data);
});

// PUT /r2/* - Upload file to R2 via Worker binding
internalRoutes.put('/r2/*', async (c) => {
  const key = c.req.path.replace('/internal/r2/', '');
  if (!key) {
    return c.json({ error: 'Key is required' }, 400);
  }

  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  const body = await c.req.arrayBuffer();

  await c.env.R2.put(key, body, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000' },
  });

  return c.json({ key, size: body.byteLength }, 201);
});

// POST /jobs - Create a processing job directly (no Queue dependency)
internalRoutes.post('/jobs', async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ gutenbergId: number; priority?: number }>();

  if (!body.gutenbergId || isNaN(body.gutenbergId)) {
    return c.json({ error: 'gutenbergId is required' }, 400);
  }

  const jobId = crypto.randomUUID();
  await db.insert(processJobs).values({
    id: jobId,
    gutenbergId: body.gutenbergId,
    status: 'queued',
    priority: body.priority ?? 0,
  });

  return c.json({ jobId }, 201);
});

// GET /books/exists - Check existing books by gutenberg IDs
internalRoutes.get('/books/exists', async (c) => {
  const db = drizzle(c.env.DB);
  const idsParam = c.req.query('gutenberg_ids');

  if (!idsParam) {
    return c.json({ existingIds: [] });
  }

  const gutenbergIds = idsParam.split(',').map(Number).filter((n) => !isNaN(n));

  if (gutenbergIds.length === 0) {
    return c.json({ existingIds: [] });
  }

  const existing = await db
    .select({ gutenbergId: books.gutenbergId })
    .from(books)
    .where(inArray(books.gutenbergId, gutenbergIds));

  const existingIds = existing
    .map((row) => row.gutenbergId)
    .filter((id): id is number => id !== null);

  return c.json({ existingIds });
});
