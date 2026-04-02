-- Add difficulty analysis and enrichment fields to books table
ALTER TABLE `books` ADD COLUMN `flesch_score` real;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `cefr_level` text;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `difficulty_score` real;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `estimated_reading_minutes` integer;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `ai_description` text;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `ai_tags` text;
--> statement-breakpoint
ALTER TABLE `books` ADD COLUMN `cover_source` text DEFAULT 'epub';
--> statement-breakpoint
CREATE INDEX `books_cefr_level_idx` ON `books` (`cefr_level`);
--> statement-breakpoint
CREATE INDEX `books_difficulty_score_idx` ON `books` (`difficulty_score`);
