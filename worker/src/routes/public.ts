import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, like, sql, and, count, asc, or, inArray } from 'drizzle-orm';
import { books, chapters, authors, bookAuthors } from '../db/schema';
import type { Env } from '../index';

export const publicRoutes = new Hono<Env>();

// GET /books - Paginated book list
publicRoutes.get('/books', async (c) => {
  const db = drizzle(c.env.DB);
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20));
  const search = c.req.query('search');
  const language = c.req.query('language');
  const status = c.req.query('status');
  const offset = (page - 1) * limit;

  const conditions = [];

  // Default: show only 'ready' and 'approved'
  if (status) {
    conditions.push(eq(books.status, status));
  } else {
    conditions.push(
      or(eq(books.status, 'ready'), eq(books.status, 'approved'))!
    );
  }

  if (language) {
    conditions.push(eq(books.language, language));
  }

  if (search) {
    conditions.push(
      or(
        like(books.title, `%${search}%`),
        like(books.author, `%${search}%`)
      )!
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [data, totalResult] = await Promise.all([
    db.select().from(books).where(where).limit(limit).offset(offset),
    db.select({ count: count() }).from(books).where(where),
  ]);

  return c.json({
    data,
    total: totalResult[0]?.count ?? 0,
    page,
    limit,
  });
});

// GET /books/:id - Single book with author info
publicRoutes.get('/books/:id', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');

  const book = await db.select().from(books).where(eq(books.id, id)).get();
  if (!book) {
    return c.json({ error: 'Book not found' }, 404);
  }

  const bookAuthorRows = await db
    .select({
      authorId: bookAuthors.authorId,
      role: bookAuthors.role,
      name: authors.name,
      birthYear: authors.birthYear,
      deathYear: authors.deathYear,
    })
    .from(bookAuthors)
    .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
    .where(eq(bookAuthors.bookId, id));

  return c.json({ ...book, authors: bookAuthorRows });
});

// GET /books/:id/chapters - Chapter list ordered by orderNum
publicRoutes.get('/books/:id/chapters', async (c) => {
  const db = drizzle(c.env.DB);
  const bookId = c.req.param('id');

  const data = await db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.orderNum));

  return c.json({ data });
});

// GET /books/:id/chapters/:cid - Single chapter detail
publicRoutes.get('/books/:id/chapters/:cid', async (c) => {
  const db = drizzle(c.env.DB);
  const cid = c.req.param('cid');

  const chapter = await db.select().from(chapters).where(eq(chapters.id, cid)).get();
  if (!chapter) {
    return c.json({ error: 'Chapter not found' }, 404);
  }

  return c.json(chapter);
});

// GET /authors - Paginated author list
publicRoutes.get('/authors', async (c) => {
  const db = drizzle(c.env.DB);
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20));
  const search = c.req.query('search');
  const offset = (page - 1) * limit;

  const where = search ? like(authors.name, `%${search}%`) : undefined;

  const [data, totalResult] = await Promise.all([
    db.select().from(authors).where(where).limit(limit).offset(offset),
    db.select({ count: count() }).from(authors).where(where),
  ]);

  return c.json({
    data,
    total: totalResult[0]?.count ?? 0,
    page,
    limit,
  });
});

// GET /authors/:id - Author detail with associated books
publicRoutes.get('/authors/:id', async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param('id');

  const author = await db.select().from(authors).where(eq(authors.id, id)).get();
  if (!author) {
    return c.json({ error: 'Author not found' }, 404);
  }

  const authorBookRows = await db
    .select({
      bookId: bookAuthors.bookId,
      role: bookAuthors.role,
      title: books.title,
      language: books.language,
      status: books.status,
    })
    .from(bookAuthors)
    .innerJoin(books, eq(bookAuthors.bookId, books.id))
    .where(eq(bookAuthors.authorId, id));

  return c.json({ ...author, books: authorBookRows });
});

// GET /content/* - Serve R2 content publicly
publicRoutes.get('/content/*', async (c) => {
  // Sanitize the key to prevent path traversal attacks (CWE-22).
  // 1. Strip the route prefix, removing any leading slashes.
  // 2. Normalize away `.` and `..` segments by resolving the path against a
  //    virtual root, then reject anything that escapes that root.
  const rawKey = c.req.path.replace(/^\/content\//, '');
  const segments = rawKey.split('/');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '..') {
      resolved.pop();
    } else if (seg !== '.' && seg !== '') {
      resolved.push(seg);
    }
  }
  const key = resolved.join('/');
  // A valid key must be non-empty and must not have escaped the virtual root
  // (i.e., resolved.length must never have gone negative, which is guaranteed
  // because Array.pop() on an empty array is a no-op, so no segment can
  // push us above the root).
  if (!key) {
    return c.json({ error: 'Key is required' }, 400);
  }

  const object = await c.env.R2.get(key);
  if (!object) {
    return c.json({ error: 'Not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Cache-Control', object.httpMetadata?.cacheControl || 'public, max-age=31536000');
  headers.set('ETag', object.etag);

  return new Response(object.body, { headers });
});

// GET /stats - Aggregate counts
publicRoutes.get('/stats', async (c) => {
  const db = drizzle(c.env.DB);

  const [totalResult, statusResult, languageResult] = await Promise.all([
    db.select({ count: count() }).from(books),
    db
      .select({ status: books.status, count: count() })
      .from(books)
      .groupBy(books.status),
    db
      .select({ language: books.language, count: count() })
      .from(books)
      .groupBy(books.language),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusResult) {
    if (row.status) byStatus[row.status] = row.count;
  }

  const byLanguage: Record<string, number> = {};
  for (const row of languageResult) {
    if (row.language) byLanguage[row.language] = row.count;
  }

  return c.json({
    totalBooks: totalResult[0]?.count ?? 0,
    byStatus,
    byLanguage,
  });
});
