import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

// Books table
export const books = sqliteTable('books', {
  id: text('id').primaryKey(),
  gutenbergId: integer('gutenberg_id').unique(),
  title: text('title').notNull(),
  author: text('author').notNull(),
  language: text('language').default('en'),
  subjects: text('subjects'),           // JSON array
  bookshelves: text('bookshelves'),     // JSON array
  description: text('description'),
  wordCount: integer('word_count').default(0),
  chapterCount: integer('chapter_count').default(0),
  coverUrl: text('cover_url'),
  epubUrl: text('epub_url'),
  sourceUrl: text('source_url'),
  status: text('status').default('pending'),  // pending/processing/ready/approved/rejected/error
  qualityScore: real('quality_score'),
  qualityIssues: text('quality_issues'),      // JSON array
  approvedAt: text('approved_at'),
  syncedAt: text('synced_at'),
  readmigoBookId: text('readmigo_book_id'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => [
  index('books_status_idx').on(table.status),
  index('books_gutenberg_id_idx').on(table.gutenbergId),
]);

// Chapters table
export const chapters = sqliteTable('chapters', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  orderNum: integer('order_num').notNull(),
  title: text('title').notNull(),
  contentUrl: text('content_url'),
  wordCount: integer('word_count').default(0),
  qualityOk: integer('quality_ok').default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('chapters_book_order_idx').on(table.bookId, table.orderNum),
]);

// Authors table
export const authors = sqliteTable('authors', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  gutenbergIds: text('gutenberg_ids'),   // JSON array
  birthYear: integer('birth_year'),
  deathYear: integer('death_year'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});

// Book-Authors join table (many-to-many)
export const bookAuthors = sqliteTable('book_authors', {
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => authors.id, { onDelete: 'cascade' }),
  role: text('role').default('author'),  // author/translator/editor
}, (table) => [
  // Composite primary key workaround for Drizzle SQLite
  uniqueIndex('book_authors_pk').on(table.bookId, table.authorId),
]);

// Process Jobs table
export const processJobs = sqliteTable('process_jobs', {
  id: text('id').primaryKey(),
  gutenbergId: integer('gutenberg_id').notNull(),
  status: text('status').default('queued'),  // queued/downloading/parsing/cleaning/uploading/done/failed
  priority: integer('priority').default(0),   // download_count, higher = process first
  stepDetail: text('step_detail'),
  attempts: integer('attempts').default(0),
  errorMessage: text('error_message'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => [
  index('jobs_status_priority_idx').on(table.status, table.priority),
]);

// Quality Reviews table
export const qualityReviews = sqliteTable('quality_reviews', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  reviewer: text('reviewer').default('auto'),  // auto/manual
  action: text('action'),                       // approve/reject/flag
  issues: text('issues'),                       // JSON array
  notes: text('notes'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
});
