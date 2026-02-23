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
