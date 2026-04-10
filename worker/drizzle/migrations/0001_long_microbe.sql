CREATE TABLE `readmigo_synced_ids` (
	`gutenberg_id` integer PRIMARY KEY NOT NULL,
	`synced_at` text DEFAULT (datetime('now'))
);
