CREATE TABLE `cg_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`file_id` text NOT NULL,
	`class_name` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`type_name` text NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `ix_cgbind_project_name` ON `cg_bindings` (`project_id`,`name`);--> statement-breakpoint
ALTER TABLE `cg_calls` ADD `receiver_name` text DEFAULT '' NOT NULL;