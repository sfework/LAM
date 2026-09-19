ALTER TABLE `skills` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `superseded_by` text;--> statement-breakpoint
ALTER TABLE `skills` ADD `project_id` text;--> statement-breakpoint
CREATE INDEX `ix_skills_project` ON `skills` (`project_id`);--> statement-breakpoint
CREATE INDEX `ix_skills_status` ON `skills` (`status`);