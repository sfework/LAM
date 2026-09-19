ALTER TABLE `cg_calls` ADD `is_member` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cg_calls` ADD `is_self` integer DEFAULT false NOT NULL;