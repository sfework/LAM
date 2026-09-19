CREATE TABLE `cg_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_symbol_id` text NOT NULL,
	`callee_name` text NOT NULL,
	`line` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `ix_cgcall_project` ON `cg_calls` (`project_id`,`callee_name`);--> statement-breakpoint
CREATE INDEX `ix_cgcall_from` ON `cg_calls` (`project_id`,`from_symbol_id`);--> statement-breakpoint
CREATE TABLE `cg_status` (
	`project_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`total_files` integer DEFAULT 0 NOT NULL,
	`indexed_files` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`last_indexed_at` integer,
	`updated_at` integer NOT NULL
);
