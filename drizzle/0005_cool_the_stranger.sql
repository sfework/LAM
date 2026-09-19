CREATE TABLE `cg_extends` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`file_id` text NOT NULL,
	`class_name` text NOT NULL,
	`super_name` text NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `ix_cgext_project_class` ON `cg_extends` (`project_id`,`class_name`);--> statement-breakpoint
CREATE TABLE `cg_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`file_id` text NOT NULL,
	`local_name` text NOT NULL,
	`source` text NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `ix_cgimp_project_local` ON `cg_imports` (`project_id`,`local_name`);--> statement-breakpoint
ALTER TABLE `cg_symbols` ADD `qualified_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `cg_symbols` ADD `parent_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `ix_cgsym_project_qname` ON `cg_symbols` (`project_id`,`qualified_name`);