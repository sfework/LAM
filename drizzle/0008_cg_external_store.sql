DROP TABLE `cg_bindings`;--> statement-breakpoint
DROP TABLE `cg_calls`;--> statement-breakpoint
DROP TABLE `cg_edges`;--> statement-breakpoint
DROP TABLE `cg_extends`;--> statement-breakpoint
DROP TABLE `cg_files`;--> statement-breakpoint
DROP TABLE `cg_imports`;--> statement-breakpoint
DROP TABLE `cg_symbols`;--> statement-breakpoint
ALTER TABLE `cg_status` ADD `turns_since_index` integer DEFAULT 0 NOT NULL;