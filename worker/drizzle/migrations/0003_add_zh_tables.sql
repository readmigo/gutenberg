-- Chinese book sources tracking table
CREATE TABLE `zh_sources` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `source_type` text NOT NULL,
  `source_url` text,
  `source_book_id` text NOT NULL,
  `title` text,
  `author` text,
  `status` text DEFAULT 'discovered',
  `epub_format` text,
  `download_url` text,
  `error` text,
  `created_at` text DEFAULT (datetime('now')),
  `updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zh_sources_type_id_idx` ON `zh_sources` (`source_type`, `source_book_id`);
--> statement-breakpoint
CREATE INDEX `zh_sources_status_idx` ON `zh_sources` (`status`);
--> statement-breakpoint

-- Chinese book correction history
CREATE TABLE `zh_corrections` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `book_id` text NOT NULL REFERENCES `books`(`id`) ON DELETE CASCADE,
  `chapter_index` integer,
  `field` text NOT NULL,
  `old_value` text,
  `new_value` text,
  `corrected_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `zh_corrections_book_idx` ON `zh_corrections` (`book_id`);
--> statement-breakpoint

-- Extend books table for Chinese book metadata
ALTER TABLE `books` ADD COLUMN `source_type` text DEFAULT 'gutenberg';
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `original_script` text;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `dynasty` text;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `hsk_level` integer;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `needs_correction` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `punctuation_added` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `cover_prompt` text;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `zh_source_id` integer;
--> statement-breakpoint
CREATE INDEX `books_source_type_idx` ON `books` (`source_type`);
--> statement-breakpoint
CREATE INDEX `books_needs_correction_idx` ON `books` (`needs_correction`);
