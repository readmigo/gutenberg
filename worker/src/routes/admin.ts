import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, count, and } from 'drizzle-orm';
import { books, processJobs, qualityReviews } from '../db/schema';
import { adminAuth } from '../middleware/auth';
import type { Env } from '../index';

export const adminRoutes = new Hono<Env>();

// Apply adminAuth to all routes in this group
adminRoutes.use('*', adminAuth);

// POST /discover - Trigger discovery
adminRoutes.post('/discover', async (c) => {
  await c.env.PROCESS_QUEUE.send({ type: 'discover' });
  return c.json({ message: 'Discovery triggered' });
});

// POST /process/:gutenbergId - Trigger single book processing
adminRoutes.post('/process/:gutenbergId', async (c) => {
  const db = drizzle(c.env.DB);
  const gutenbergId = Number(c.req.param('gutenbergId'));

  if (isNaN(gutenbergId)) {
    return c.json({ error: 'Invalid gutenbergId' }, 400);
  }

  const jobId = crypto.randomUUID();
  await db.insert(processJobs).values({
    id: jobId,
    gutenbergId,
    status: 'queued',
    priority: 0,
  });

  await c.env.PROCESS_QUEUE.send({
    type: 'process',
    jobId,
    gutenbergId,
  });

  return c.json({ jobId, message: 'Processing triggered' });
});

// GET /jobs - Job list
adminRoutes.get('/jobs', async (c) => {
  const db = drizzle(c.env.DB);
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20));
  const status = c.req.query('status');
  const offset = (page - 1) * limit;

  const where = status ? eq(processJobs.status, status) : undefined;

  const [data, totalResult] = await Promise.all([
    db
      .select()
      .from(processJobs)
      .where(where)
      .orderBy(desc(processJobs.priority))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(processJobs).where(where),
  ]);

  return c.json({
    data,
    total: totalResult[0]?.count ?? 0,
    page,
    limit,
  });
});

// GET /jobs/:id - Single job detail
adminRoutes.get('/jobs/:id', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');

  const job = await db.select().from(processJobs).where(eq(processJobs.id, id)).get();
  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  return c.json(job);
});

// POST /books/:id/approve - Approve a book
adminRoutes.post('/books/:id/approve', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');
  const body = await c.req.json<{ notes?: string }>().catch(() => ({}));

  const book = await db.select().from(books).where(eq(books.id, id)).get();
  if (!book) {
    return c.json({ error: 'Book not found' }, 404);
  }

  const now = new Date().toISOString();

  await db
    .update(books)
    .set({ status: 'approved', approvedAt: now, updatedAt: now })
    .where(eq(books.id, id));

  await db.insert(qualityReviews).values({
    id: crypto.randomUUID(),
    bookId: id,
    reviewer: 'manual',
    action: 'approve',
    notes: (body as { notes?: string }).notes ?? null,
  });

  return c.json({ message: 'Book approved' });
});

// POST /books/:id/reject - Reject a book
adminRoutes.post('/books/:id/reject', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');
  const body = await c.req.json<{ notes: string }>();

  if (!body.notes) {
    return c.json({ error: 'Notes are required for rejection' }, 400);
  }

  const book = await db.select().from(books).where(eq(books.id, id)).get();
  if (!book) {
    return c.json({ error: 'Book not found' }, 404);
  }

  const now = new Date().toISOString();

  await db
    .update(books)
    .set({ status: 'rejected', updatedAt: now })
    .where(eq(books.id, id));

  await db.insert(qualityReviews).values({
    id: crypto.randomUUID(),
    bookId: id,
    reviewer: 'manual',
    action: 'reject',
    notes: body.notes,
  });

  return c.json({ message: 'Book rejected' });
});

// POST /books/:id/sync - Sync approved book to Readmigo API
adminRoutes.post('/books/:id/sync', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');

  const book = await db.select().from(books).where(eq(books.id, id)).get();
  if (!book) {
    return c.json({ error: 'Book not found' }, 404);
  }

  const now = new Date().toISOString();

  // Placeholder: actual Readmigo API call will be implemented later
  await db
    .update(books)
    .set({ syncedAt: now, updatedAt: now })
    .where(eq(books.id, id));

  return c.json({ message: 'Sync initiated' });
});
