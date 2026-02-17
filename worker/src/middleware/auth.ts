import { Context, Next } from 'hono';
import type { Env } from '../index';

// Admin routes: Bearer Token
export async function adminAuth(c: Context<Env>, next: Next) {
  const auth = c.req.header('Authorization');
  if (!auth || auth !== `Bearer ${c.env.ADMIN_TOKEN}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
}

// Internal routes: API Key header
export async function internalAuth(c: Context<Env>, next: Next) {
  const key = c.req.header('X-Internal-Key');
  if (!key || key !== c.env.INTERNAL_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
}
