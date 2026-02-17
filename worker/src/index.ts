import { Hono } from 'hono';
import { cors } from 'hono/cors';

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

app.use('*', cors());

app.get('/', (c) => c.json({ service: 'gutenberg-api', status: 'ok' }));

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: any, ctx: ExecutionContext) {
    console.log('cron triggered');
  },
  async queue(batch: MessageBatch<any>, env: any) {
    console.log(`processing ${batch.messages.length} messages`);
  },
};
