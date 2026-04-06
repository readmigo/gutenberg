-- Track which pipeline version processed each book so stale records can be
-- re-run when the processing code is upgraded. Books written before this
-- migration default to version 0, which flags them as eligible for reprocess.
ALTER TABLE `books` ADD COLUMN `pipeline_version` integer DEFAULT 0;
--> statement-breakpoint
CREATE INDEX `books_pipeline_version_idx` ON `books` (`pipeline_version`);
