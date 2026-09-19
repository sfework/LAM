CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`mcp_config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cg_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_symbol_id` text NOT NULL,
	`to_symbol_id` text NOT NULL,
	`kind` text DEFAULT 'calls' NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `ix_cgedge_from` ON `cg_edges` (`project_id`,`from_symbol_id`);--> statement-breakpoint
CREATE INDEX `ix_cgedge_to` ON `cg_edges` (`project_id`,`to_symbol_id`);--> statement-breakpoint
CREATE TABLE `cg_files` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`lang` text DEFAULT '' NOT NULL,
	`hash` text DEFAULT '' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`indexed_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cgfile` ON `cg_files` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `cg_symbols` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`file_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT '' NOT NULL,
	`line` integer DEFAULT 0 NOT NULL,
	`end_line` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `ix_cgsym_project_name` ON `cg_symbols` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `denoise_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`start_text` text NOT NULL,
	`end_text` text NOT NULL,
	`apply_forward` integer DEFAULT true NOT NULL,
	`apply_memory` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `extract_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_key` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_queue_status` ON `extract_queue` (`status`);--> statement-breakpoint
CREATE TABLE `knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`project_id` text,
	`enabled` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `ix_knowledge_project` ON `knowledge` (`project_id`);--> statement-breakpoint
CREATE TABLE `mem_l0` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_key` text NOT NULL,
	`turn_seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_l0_turn` ON `mem_l0` (`project_id`,`session_key`,`turn_seq`,`role`);--> statement-breakpoint
CREATE INDEX `ix_l0_project` ON `mem_l0` (`project_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `mem_l1` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`priority` integer DEFAULT 60 NOT NULL,
	`scene_name` text,
	`source_l0_ids` text DEFAULT '[]' NOT NULL,
	`batch_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`superseded_by` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `ix_l1_project` ON `mem_l1` (`project_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `ix_l1_batch` ON `mem_l1` (`batch_id`);--> statement-breakpoint
CREATE TABLE `mem_l2` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_l2_project` ON `mem_l2` (`project_id`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`key` text DEFAULT '' NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_models_category` ON `models` (`category`);--> statement-breakpoint
CREATE TABLE `pipeline_state` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_key` text NOT NULL,
	`conversation_count` integer DEFAULT 0 NOT NULL,
	`warmup_threshold` integer DEFAULT 0 NOT NULL,
	`last_scene_name` text,
	`last_l1_at` integer,
	`last_l2_at` integer,
	`buffered_message_ids` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pipeline_session` ON `pipeline_state` (`project_id`,`session_key`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_projects_path` ON `projects` (`path`);--> statement-breakpoint
CREATE INDEX `ix_projects_deleted` ON `projects` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_key` text NOT NULL,
	`project_id` text NOT NULL,
	`source` text DEFAULT 'derived' NOT NULL,
	`inject_snapshot` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`handled_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sessions_key` ON `sessions` (`session_key`);--> statement-breakpoint
CREATE INDEX `ix_sessions_project` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`resources` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
