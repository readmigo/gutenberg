import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, sql, and, inArray, ne } from 'drizzle-orm';
import { internalAuth } from '../middleware/auth';
import { books, chapters, zhSources, zhCorrections } from '../db/schema';
import type { Env } from '../index';

export const zhRoutes = new Hono<Env>();

// Apply internalAuth to all routes in this group
zhRoutes.use('*', internalAuth);

// Global error handler
zhRoutes.onError((err, c) => {
  console.error('ZH route error:', err.message, err.stack);
  return c.json({ error: err.message }, 500);
});

// POST /sources - Create zh_source record
zhRoutes.post('/sources', async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    sourceType: string;
    sourceBookId: string;
    title?: string;
    author?: string;
    epubFormat?: string;
    downloadUrl?: string;
    sourceUrl?: string;
    error?: string;
  }>();

  if (!body.sourceType || !body.sourceBookId) {
    return c.json({ error: 'sourceType and sourceBookId are required' }, 400);
  }

  // Check uniqueness by (sourceType, sourceBookId)
  const existing = await db
    .select()
    .from(zhSources)
    .where(and(eq(zhSources.sourceType, body.sourceType), eq(zhSources.sourceBookId, body.sourceBookId)))
    .get();

  if (existing) {
    return c.json({ error: 'Source already exists', id: existing.id }, 409);
  }

  const now = new Date().toISOString();
  const result = await db.insert(zhSources).values({
    sourceType: body.sourceType,
    sourceBookId: body.sourceBookId,
    title: body.title,
    author: body.author,
    status: 'discovered',
    epubFormat: body.epubFormat,
    downloadUrl: body.downloadUrl,
    sourceUrl: body.sourceUrl,
    error: body.error,
    createdAt: now,
    updatedAt: now,
  }).returning();

  return c.json(result[0], 201);
});

// GET /sources - List zh_sources
zhRoutes.get('/sources', async (c) => {
  const db = drizzle(c.env.DB);
  const status = c.req.query('status');
  const sourceType = c.req.query('source_type');
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);

  let query = db.select().from(zhSources).$dynamic();

  const conditions = [];
  if (status) conditions.push(eq(zhSources.status, status));
  if (sourceType) conditions.push(eq(zhSources.sourceType, sourceType));

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const data = await query.orderBy(desc(zhSources.id)).limit(limit).offset(offset);
  return c.json(data);
});

// PUT /sources/:id - Update zh_source fields
zhRoutes.put('/sources/:id', async (c) => {
  const db = drizzle(c.env.DB);
  const id = Number(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

  const body = await c.req.json();
  const now = new Date().toISOString();

  await db
    .update(zhSources)
    .set({ ...body, updatedAt: now })
    .where(eq(zhSources.id, id));

  return c.json({ message: 'Updated' });
});

// GET /books - List Chinese books where source_type != 'gutenberg'
zhRoutes.get('/books', async (c) => {
  const db = drizzle(c.env.DB);
  const status = c.req.query('status');
  const sourceType = c.req.query('source_type');
  const needsCorrection = c.req.query('needs_correction');
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);

  let query = db.select().from(books).$dynamic();

  const conditions: ReturnType<typeof eq>[] = [ne(books.sourceType, 'gutenberg')];
  if (status) conditions.push(eq(books.status, status));
  if (sourceType) conditions.push(eq(books.sourceType, sourceType));
  if (needsCorrection !== undefined && needsCorrection !== '') {
    conditions.push(eq(books.needsCorrection, Number(needsCorrection)));
  }

  query = query.where(and(...conditions));

  const data = await query.orderBy(desc(books.createdAt)).limit(limit).offset(offset);
  return c.json(data);
});

// GET /books/:id - Book detail with chapters and corrections
zhRoutes.get('/books/:id', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');

  const book = await db.select().from(books).where(eq(books.id, id)).get();
  if (!book) return c.json({ error: 'Not found' }, 404);

  const bookChapters = await db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, id))
    .orderBy(chapters.orderNum);

  const corrections = await db
    .select()
    .from(zhCorrections)
    .where(eq(zhCorrections.bookId, id))
    .orderBy(desc(zhCorrections.correctedAt));

  return c.json({ ...book, chapters: bookChapters, corrections });
});

// PATCH /books/:id - Update book fields with correction tracking
zhRoutes.patch('/books/:id', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const now = new Date().toISOString();

  const book = await db.select().from(books).where(eq(books.id, id)).get();
  if (!book) return c.json({ error: 'Not found' }, 404);

  // Tracked fields: compare old vs new and insert zh_corrections
  const trackedFields = ['title', 'author', 'dynasty', 'description'] as const;
  const correctionRecords: {
    bookId: string;
    field: string;
    oldValue: string | null;
    newValue: string | null;
    correctedAt: string;
  }[] = [];

  for (const field of trackedFields) {
    if (field in body && body[field] !== book[field]) {
      correctionRecords.push({
        bookId: id,
        field,
        oldValue: book[field] != null ? String(book[field]) : null,
        newValue: body[field] != null ? String(body[field]) : null,
        correctedAt: now,
      });
    }
  }

  if (correctionRecords.length > 0) {
    for (const record of correctionRecords) {
      await db.insert(zhCorrections).values(record);
    }
  }

  await db
    .update(books)
    .set({ ...body, updatedAt: now })
    .where(eq(books.id, id));

  return c.json({ message: 'Updated', corrections: correctionRecords.length });
});

// POST /books/:id/correct - Mark book as needing correction
zhRoutes.post('/books/:id/correct', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');
  const now = new Date().toISOString();

  await db
    .update(books)
    .set({ needsCorrection: 2, updatedAt: now })
    .where(eq(books.id, id));

  return c.json({ message: 'Marked for correction' });
});

// POST /books/:id/sync - Set book status to ready
zhRoutes.post('/books/:id/sync', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');
  const now = new Date().toISOString();

  await db
    .update(books)
    .set({ status: 'ready', updatedAt: now })
    .where(eq(books.id, id));

  return c.json({ message: 'Marked as ready' });
});

// POST /books/batch - Batch correct or sync books
zhRoutes.post('/books/batch', async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ bookIds: string[]; action: 'correct' | 'sync' }>();

  if (!body.bookIds?.length || !body.action) {
    return c.json({ error: 'bookIds and action are required' }, 400);
  }
  if (!['correct', 'sync'].includes(body.action)) {
    return c.json({ error: 'action must be "correct" or "sync"' }, 400);
  }

  const now = new Date().toISOString();
  const updateFields =
    body.action === 'correct'
      ? { needsCorrection: 2, updatedAt: now }
      : { status: 'ready', updatedAt: now };

  const BATCH = 20;
  let processed = 0;
  for (let i = 0; i < body.bookIds.length; i += BATCH) {
    const batch = body.bookIds.slice(i, i + BATCH);
    await db.update(books).set(updateFields).where(inArray(books.id, batch));
    processed += batch.length;
  }

  return c.json({ processed });
});
