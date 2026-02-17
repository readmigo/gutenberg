CREATE TABLE `authors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`gutenberg_ids` text,
	`birth_year` integer,
	`death_year` integer,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authors_name_unique` ON `authors` (`name`);--> statement-breakpoint
CREATE TABLE `book_authors` (
	`book_id` text NOT NULL,
	`author_id` text NOT NULL,
	`role` text DEFAULT 'author',
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_authors_pk` ON `book_authors` (`book_id`,`author_id`);--> statement-breakpoint
CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`gutenberg_id` integer,
	`title` text NOT NULL,
	`author` text NOT NULL,
	`language` text DEFAULT 'en',
	`subjects` text,
	`bookshelves` text,
	`description` text,
	`word_count` integer DEFAULT 0,
	`chapter_count` integer DEFAULT 0,
	`cover_url` text,
	`epub_url` text,
	`source_url` text,
	`status` text DEFAULT 'pending',
	`quality_score` real,
	`quality_issues` text,
	`approved_at` text,
	`synced_at` text,
	`readmigo_book_id` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_gutenberg_id_unique` ON `books` (`gutenberg_id`);--> statement-breakpoint
CREATE INDEX `books_status_idx` ON `books` (`status`);--> statement-breakpoint
CREATE INDEX `books_gutenberg_id_idx` ON `books` (`gutenberg_id`);--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`order_num` integer NOT NULL,
	`title` text NOT NULL,
	`content_url` text,
	`word_count` integer DEFAULT 0,
	`quality_ok` integer DEFAULT 1,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chapters_book_order_idx` ON `chapters` (`book_id`,`order_num`);--> statement-breakpoint
CREATE TABLE `process_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`gutenberg_id` integer NOT NULL,
	`status` text DEFAULT 'queued',
	`priority` integer DEFAULT 0,
	`step_detail` text,
	`attempts` integer DEFAULT 0,
	`error_message` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `jobs_status_priority_idx` ON `process_jobs` (`status`,`priority`);--> statement-breakpoint
CREATE TABLE `quality_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`reviewer` text DEFAULT 'auto',
	`action` text,
	`issues` text,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
