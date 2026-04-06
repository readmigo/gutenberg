import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, count, and, lt, inArray, or, isNull } from 'drizzle-orm';
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

// POST /books/reprocess - Queue stale books for reprocessing
//
// Body: {
//   minVersion?: number     // reprocess books where pipelineVersion < this
//   gutenbergIds?: number[] // or explicit list of Gutenberg IDs
//   status?: string         // optional status filter (e.g. 'ready', 'rejected')
//   limit?: number          // cap (default 500, max 5000)
//   dryRun?: boolean        // if true, report candidates without enqueuing
// }
//
// Creates one `queued` row in `process_jobs` per matching book, which the
// PM2-hosted pg-batch script on the Droplet picks up on its next poll.
// Books that already have a queued/in-progress job are skipped so repeated
// calls are idempotent.
adminRoutes.post('/books/reprocess', async (c) => {
  const db = drizzle(c.env.DB);
  type ReprocessBody = {
    minVersion?: number;
    gutenbergIds?: number[];
    status?: string;
    limit?: number;
    dryRun?: boolean;
  };
  const body: ReprocessBody = await c.req
    .json<ReprocessBody>()
    .catch(() => ({} as ReprocessBody));

  const limit = Math.min(5000, Math.max(1, body.limit ?? 500));
  const dryRun = body.dryRun === true;

  const conditions = [];
  if (Array.isArray(body.gutenbergIds) && body.gutenbergIds.length > 0) {
    const ids = body.gutenbergIds.filter((n: number) => Number.isInteger(n));
    if (ids.length === 0) {
      return c.json({ error: 'gutenbergIds must contain integers' }, 400);
    }
    conditions.push(inArray(books.gutenbergId, ids));
  }
  if (typeof body.minVersion === 'number') {
    // Treat NULL pipeline_version as 0 so pre-versioning records are included.
    conditions.push(
      or(lt(books.pipelineVersion, body.minVersion), isNull(books.pipelineVersion))!,
    );
  }
  if (typeof body.status === 'string' && body.status.length > 0) {
    conditions.push(eq(books.status, body.status));
  }

  if (conditions.length === 0) {
    return c.json(
      { error: 'Provide at least one of: minVersion, gutenbergIds, status' },
      400,
    );
  }

  const candidates = await db
    .select({
      id: books.id,
      gutenbergId: books.gutenbergId,
      title: books.title,
      pipelineVersion: books.pipelineVersion,
      status: books.status,
    })
    .from(books)
    .where(and(...conditions))
    .limit(limit);

  // Filter out books without a gutenbergId and those that already have an
  // active job. Doing this in JS keeps the SQL simple and D1-friendly.
  const withGid = candidates.filter(
    (b): b is typeof b & { gutenbergId: number } => b.gutenbergId !== null,
  );
  const gids = withGid.map((b) => b.gutenbergId);

  let alreadyActive = new Set<number>();
  if (gids.length > 0) {
    const activeJobs = await db
      .select({ gutenbergId: processJobs.gutenbergId, status: processJobs.status })
      .from(processJobs)
      .where(
        and(
          inArray(processJobs.gutenbergId, gids),
          inArray(processJobs.status, [
            'queued',
            'downloading',
            'parsing',
            'cleaning',
            'uploading',
          ]),
        ),
      );
    alreadyActive = new Set(activeJobs.map((j) => j.gutenbergId));
  }

  const toQueue = withGid.filter((b) => !alreadyActive.has(b.gutenbergId));

  const sample = toQueue.slice(0, 20).map((b) => ({
    gutenbergId: b.gutenbergId,
    title: b.title,
    pipelineVersion: b.pipelineVersion ?? 0,
    status: b.status,
  }));

  if (dryRun) {
    return c.json({
      dryRun: true,
      matched: candidates.length,
      withoutGutenbergId: candidates.length - withGid.length,
      alreadyActive: alreadyActive.size,
      wouldQueue: toQueue.length,
      sample,
    });
  }

  // Insert jobs in small batches to respect D1's SQL variable limit.
  let queued = 0;
  const BATCH_SIZE = 20;
  for (let i = 0; i < toQueue.length; i += BATCH_SIZE) {
    const slice = toQueue.slice(i, i + BATCH_SIZE);
    await db.insert(processJobs).values(
      slice.map((b) => ({
        id: crypto.randomUUID(),
        gutenbergId: b.gutenbergId,
        status: 'queued',
        // High priority so reprocess jobs jump ahead of discovery backlog.
        priority: 1_000_000,
      })),
    );
    queued += slice.length;
  }

  return c.json({
    dryRun: false,
    matched: candidates.length,
    alreadyActive: alreadyActive.size,
    queued,
    sample,
  });
});

// POST /r2/purge - One-off cleanup utility to wipe a key prefix in R2.
//
// Body: { prefix: string, dryRun?: boolean, maxBatches?: number }
//
// R2's list API paginates; this loops until the cursor is exhausted. Each
// batch is deleted in bulk with R2Bucket.delete(keys[]). With ~15k objects
// and 1000-per-page listing, expect ~15 batches.
//
// This exists to let us wipe the `books/` prefix after a D1 truncate. It is
// admin-auth protected and should be reverted after the cleanup is done.
adminRoutes.post('/r2/purge', async (c) => {
  const body = await c.req.json<{
    prefix?: string;
    dryRun?: boolean;
    maxBatches?: number;
  }>().catch(() => ({} as { prefix?: string; dryRun?: boolean; maxBatches?: number }));

  const prefix = body.prefix;
  if (!prefix || typeof prefix !== 'string' || prefix.length === 0) {
    return c.json({ error: 'prefix is required and must be a non-empty string' }, 400);
  }
  // Safety rail: don't let a buggy call nuke the whole bucket.
  if (prefix === '/' || prefix === '') {
    return c.json({ error: 'refusing to purge bucket root' }, 400);
  }

  const dryRun = body.dryRun === true;
  const maxBatches = Math.min(100, Math.max(1, body.maxBatches ?? 50));

  let cursor: string | undefined = undefined;
  let totalListed = 0;
  let totalDeleted = 0;
  let batches = 0;
  const sampleKeys: string[] = [];

  while (batches < maxBatches) {
    const listResult: R2Objects = await c.env.R2.list({
      prefix,
      limit: 1000,
      cursor,
    });
    if (listResult.objects.length === 0) break;

    totalListed += listResult.objects.length;
    if (sampleKeys.length < 10) {
      for (const o of listResult.objects) {
        if (sampleKeys.length >= 10) break;
        sampleKeys.push(o.key);
      }
    }

    if (!dryRun) {
      // R2 delete accepts an array; chunk to 1000 (also the list limit).
      await c.env.R2.delete(listResult.objects.map((o) => o.key));
      totalDeleted += listResult.objects.length;
    }

    batches++;
    if (!listResult.truncated) break;
    cursor = listResult.cursor;
  }

  return c.json({
    prefix,
    dryRun,
    batches,
    totalListed,
    totalDeleted,
    sampleKeys,
    truncatedAtBatchLimit: batches >= maxBatches,
  });
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
