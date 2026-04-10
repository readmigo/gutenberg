import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, inArray, sql } from 'drizzle-orm';
import { books, chapters, processJobs, readmigoSyncedIds } from '../db/schema';
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

// POST /books - Create or update a book record
internalRoutes.post('/books', async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json();
  const now = new Date().toISOString();

  // Check if book already exists by gutenberg_id
  const existing = await db.select().from(books).where(eq(books.gutenbergId, body.gutenbergId)).get();

  if (existing) {
    // Update existing book
    await db.update(books).set({
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
      status: body.status ?? existing.status,
      qualityScore: body.qualityScore,
      qualityIssues: body.qualityIssues,
      fleschScore: body.fleschScore,
      cefrLevel: body.cefrLevel,
      difficultyScore: body.difficultyScore,
      estimatedReadingMinutes: body.estimatedReadingMinutes,
      aiDescription: body.aiDescription,
      aiTags: body.aiTags,
      coverSource: body.coverSource,
      pipelineVersion: body.pipelineVersion,
      updatedAt: now,
    }).where(eq(books.id, existing.id));

    const updated = await db.select().from(books).where(eq(books.id, existing.id)).get();
    return c.json(updated, 200);
  }

  // Insert new book
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
    fleschScore: body.fleschScore,
    cefrLevel: body.cefrLevel,
    difficultyScore: body.difficultyScore,
    estimatedReadingMinutes: body.estimatedReadingMinutes,
    aiDescription: body.aiDescription,
    aiTags: body.aiTags,
    coverSource: body.coverSource,
    pipelineVersion: body.pipelineVersion,
  });

  const created = await db.select().from(books).where(eq(books.id, body.id)).get();
  return c.json(created, 201);
});

// GET /books - List books with filtering
internalRoutes.get('/books', async (c) => {
  const db = drizzle(c.env.DB);
  const status = c.req.query('status');
  const unsynced = c.req.query('unsynced') === 'true';
  const needsEnrichment = c.req.query('needs_enrichment') === 'true';
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 20));

  let query = db.select().from(books).$dynamic();

  const conditions = [];
  if (status) conditions.push(eq(books.status, status));
  if (unsynced) conditions.push(sql`${books.syncedAt} IS NULL`);
  if (needsEnrichment) conditions.push(sql`${books.aiDescription} IS NULL`);

  if (conditions.length > 0) {
    query = query.where(sql`${sql.join(conditions, sql` AND `)}`);
  }

  const data = await query.orderBy(desc(books.qualityScore)).limit(limit);
  return c.json(data);
});

// GET /books/:id/chapters - Get chapters for a book
internalRoutes.get('/books/:id/chapters', async (c) => {
  const db = drizzle(c.env.DB);
  const bookId = c.req.param('id');

  const data = await db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(chapters.orderNum);

  return c.json(data);
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

  // Delete existing chapters for this book (handles re-processing)
  await db.delete(chapters).where(eq(chapters.bookId, bookId));

  // D1 has a 100 SQL variable limit; batch inserts (7 fields per row -> max 14 per batch)
  const BATCH_SIZE = 10;
  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    await db.insert(chapters).values(values.slice(i, i + BATCH_SIZE));
  }

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
  const rawKey = c.req.path.replace('/internal/r2/', '');
  const key = rawKey.replace(/\.\.\//g, '').replace(/^\/+/, '');
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

// GET /stats/subjects - Get subject distribution of processed books
internalRoutes.get('/stats/subjects', async (c) => {
  const db = drizzle(c.env.DB);

  // Fetch all books with subjects (ready or approved status)
  const rows = await db
    .select({ subjects: books.subjects })
    .from(books)
    .where(sql`${books.status} IN ('ready', 'pending', 'approved')`);

  // Count subject occurrences
  const subjectCounts: Record<string, number> = {};
  for (const row of rows) {
    if (!row.subjects) continue;
    try {
      const subjects: string[] = JSON.parse(row.subjects);
      for (const s of subjects) {
        const normalized = normalizeSubject(s);
        if (normalized) {
          subjectCounts[normalized] = (subjectCounts[normalized] || 0) + 1;
        }
      }
    } catch {
      // skip invalid JSON
    }
  }

  return c.json({ totalBooks: rows.length, subjects: subjectCounts });
});

// GET /stats/cefr - Get CEFR level distribution
internalRoutes.get('/stats/cefr', async (c) => {
  const db = drizzle(c.env.DB);

  const rows = await db
    .select({ cefrLevel: books.cefrLevel, count: sql<number>`count(*)` })
    .from(books)
    .where(sql`${books.cefrLevel} IS NOT NULL`)
    .groupBy(books.cefrLevel);

  const distribution: Record<string, number> = {};
  for (const row of rows) {
    if (row.cefrLevel) distribution[row.cefrLevel] = row.count;
  }

  return c.json({ distribution });
});

// POST /books/batch-status - Batch update book status
internalRoutes.post('/books/batch-status', async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ bookIds: string[]; status: string }>();

  if (!body.bookIds?.length || !body.status) {
    return c.json({ error: 'bookIds and status are required' }, 400);
  }

  const now = new Date().toISOString();
  const BATCH = 20;
  let updated = 0;
  for (let i = 0; i < body.bookIds.length; i += BATCH) {
    const batch = body.bookIds.slice(i, i + BATCH);
    await db.update(books).set({ status: body.status, updatedAt: now }).where(inArray(books.id, batch));
    updated += batch.length;
  }

  return c.json({ updated });
});

// DELETE /r2/* - Delete file from R2
internalRoutes.delete('/r2/*', async (c) => {
  const rawKey = c.req.path.replace('/internal/r2/', '');
  const key = rawKey.replace(/\.\.\//g, '').replace(/^\/+/, '');
  if (!key) return c.json({ error: 'Key is required' }, 400);

  await c.env.R2.delete(key);
  return c.json({ deleted: key });
});

// POST /r2/delete-prefix - Delete all R2 objects under a prefix
internalRoutes.post('/r2/delete-prefix', async (c) => {
  const body = await c.req.json<{ prefix: string }>();
  if (!body.prefix) return c.json({ error: 'prefix is required' }, 400);

  let deleted = 0;
  let cursor: string | undefined;
  do {
    const list = await c.env.R2.list({ prefix: body.prefix, cursor, limit: 500 });
    if (list.objects.length > 0) {
      await c.env.R2.delete(list.objects.map((o) => o.key));
      deleted += list.objects.length;
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  return c.json({ deleted, prefix: body.prefix });
});

// GET /synced-ids - List all synced gutenberg IDs
internalRoutes.get('/synced-ids', async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select({ gutenbergId: readmigoSyncedIds.gutenbergId }).from(readmigoSyncedIds);
  return c.json({ ids: rows.map((r) => r.gutenbergId) });
});

// POST /synced-ids - Batch insert synced gutenberg IDs
internalRoutes.post('/synced-ids', async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{ gutenbergIds: number[] }>();

  if (!body.gutenbergIds?.length) return c.json({ error: 'gutenbergIds required' }, 400);

  const BATCH = 20;
  let inserted = 0;
  for (let i = 0; i < body.gutenbergIds.length; i += BATCH) {
    const batch = body.gutenbergIds.slice(i, i + BATCH);
    const values = batch.map((id) => ({ gutenbergId: id }));
    await db.insert(readmigoSyncedIds).values(values).onConflictDoNothing();
    inserted += batch.length;
  }

  return c.json({ inserted });
});

// GET /synced-ids/check - Check which gutenberg IDs are already synced
internalRoutes.get('/synced-ids/check', async (c) => {
  const db = drizzle(c.env.DB);
  const idsParam = c.req.query('gutenberg_ids');
  if (!idsParam) return c.json({ syncedIds: [] });

  const gutenbergIds = idsParam.split(',').map(Number).filter((n) => !isNaN(n));
  if (gutenbergIds.length === 0) return c.json({ syncedIds: [] });

  const rows = await db
    .select({ gutenbergId: readmigoSyncedIds.gutenbergId })
    .from(readmigoSyncedIds)
    .where(inArray(readmigoSyncedIds.gutenbergId, gutenbergIds));

  return c.json({ syncedIds: rows.map((r) => r.gutenbergId) });
});

// Normalize Gutenberg subject strings to broad categories
function normalizeSubject(subject: string): string | null {
  const s = subject.toLowerCase();

  // Map to broad categories
  if (s.includes('fiction') && !s.includes('non-fiction') && !s.includes('science fiction')) return 'Fiction';
  if (s.includes('science fiction') || s.includes('dystopi')) return 'Science Fiction';
  if (s.includes('fantasy') || s.includes('fairy tale')) return 'Fantasy';
  if (s.includes('mystery') || s.includes('detective')) return 'Mystery & Detective';
  if (s.includes('horror') || s.includes('ghost') || s.includes('gothic')) return 'Horror & Gothic';
  if (s.includes('romance') || s.includes('love stor')) return 'Romance';
  if (s.includes('adventure')) return 'Adventure';
  if (s.includes('histor')) return 'History';
  if (s.includes('philosophy') || s.includes('ethics')) return 'Philosophy';
  if (s.includes('science') || s.includes('natural history') || s.includes('biology') || s.includes('physics')) return 'Science';
  if (s.includes('poetry') || s.includes('poems')) return 'Poetry';
  if (s.includes('drama') || s.includes('plays') || s.includes('comedy') || s.includes('tragedy')) return 'Drama';
  if (s.includes('religion') || s.includes('bible') || s.includes('christian') || s.includes('theolog')) return 'Religion';
  if (s.includes('political') || s.includes('politics') || s.includes('government')) return 'Politics';
  if (s.includes('economics') || s.includes('commerce') || s.includes('trade')) return 'Economics';
  if (s.includes('education') || s.includes('children')) return 'Children & Education';
  if (s.includes('biography') || s.includes('autobiograph') || s.includes('memoir')) return 'Biography';
  if (s.includes('travel') || s.includes('voyage')) return 'Travel';
  if (s.includes('war') || s.includes('military')) return 'War & Military';
  if (s.includes('humor') || s.includes('satir')) return 'Humor & Satire';

  return null; // uncategorizable
}
