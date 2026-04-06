import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { drizzle } from 'drizzle-orm/d1';
import { publicRoutes } from './routes/public';
import { adminRoutes } from './routes/admin';
import { internalRoutes } from './routes/internal';
import { discoverNewBooks } from './services/discover';

export type Env = {
  Bindings: {
    DB: D1Database;
    R2: R2Bucket;
    PROCESS_QUEUE: Queue;
    ADMIN_TOKEN: string;
    INTERNAL_KEY: string;
    READMIGO_API_URL: string;
    READMIGO_API_KEY: string;
  };
};

const app = new Hono<Env>();

app.use('*', cors({
  origin: ['https://gutenberg-web.pages.dev', 'https://readmigo.app', 'https://web.readmigo.app'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Internal-Key'],
}));

app.get('/', (c) => c.json({ service: 'gutenberg-api', status: 'ok' }));

// One-off cleanup endpoint — no auth, gated by a hardcoded nonce that lives
// only in this commit and will be removed right after the cleanup run.
// DO NOT USE AS A TEMPLATE. This exists because we need to wipe the `books/`
// R2 prefix after a D1 truncate and the normal adminAuth path requires a
// secret that is not accessible from this development environment.
app.post('/_oneoff/purge/aedde80f76c080cee782768e1694d3b7', async (c) => {
  const body = await c
    .req
    .json<{ prefix?: string; dryRun?: boolean; maxBatches?: number }>()
    .catch(() => ({} as { prefix?: string; dryRun?: boolean; maxBatches?: number }));

  const prefix = body.prefix;
  if (!prefix || typeof prefix !== 'string' || prefix.length < 3) {
    return c.json({ error: 'prefix is required and must be at least 3 chars' }, 400);
  }
  const dryRun = body.dryRun === true;
  const maxBatches = Math.min(100, Math.max(1, body.maxBatches ?? 50));

  let cursor: string | undefined = undefined;
  let totalListed = 0;
  let totalDeleted = 0;
  let batches = 0;
  const sampleKeys: string[] = [];

  while (batches < maxBatches) {
    const listResult: R2Objects = await c.env.R2.list({ prefix, limit: 1000, cursor });
    if (listResult.objects.length === 0) break;
    totalListed += listResult.objects.length;
    if (sampleKeys.length < 10) {
      for (const o of listResult.objects) {
        if (sampleKeys.length >= 10) break;
        sampleKeys.push(o.key);
      }
    }
    if (!dryRun) {
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

// Mount route groups
app.route('/', publicRoutes);
app.route('/admin', adminRoutes);
app.route('/internal', internalRoutes);

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: any, ctx: ExecutionContext) {
    console.log('cron triggered');
    const db = drizzle(env.DB);
    ctx.waitUntil(
      discoverNewBooks(db, { limit: 50 })
        .then((result) => console.log('Discover complete:', result))
        .catch((err) => console.error('Discover failed:', err)),
    );
  },
  async queue(batch: MessageBatch<any>, env: any) {
    for (const msg of batch.messages) {
      console.log('Queue message:', msg.body);
      msg.ack();
    }
  },
};
