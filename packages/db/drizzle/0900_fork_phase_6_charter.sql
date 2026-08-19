CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`project_id` text NOT NULL,
	`source_kind` text DEFAULT 'plugin' NOT NULL,
	`plugin_id` text,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`renderer_id` text,
	`dedupe_key` text,
	`attention` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`dismissed_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_idx` ON `notifications` (`plugin_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notifications_thread_created_idx` ON `notifications` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_open_idx` ON `notifications` (`dismissed_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_project_created_idx` ON `notifications` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `thread_plugin_agent_configs` (
	`thread_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`tools_json` text NOT NULL,
	`skills_json` text NOT NULL,
	`instructions` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `plugin_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_plugin_agent_configs_plugin_idx` ON `thread_plugin_agent_configs` (`plugin_id`);--> statement-breakpoint
CREATE TABLE `thread_turns` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`project_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text,
	`model_source` text,
	`reasoning_level` text,
	`service_tier` text,
	`parent_tool_call_id` text,
	`is_root` integer DEFAULT true NOT NULL,
	`initiator` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`duration_ms` integer,
	`status` text NOT NULL,
	`error_message` text,
	`count_tool_calls` integer DEFAULT 0 NOT NULL,
	`count_commands` integer DEFAULT 0 NOT NULL,
	`count_file_changes` integer DEFAULT 0 NOT NULL,
	`count_delegations` integer DEFAULT 0 NOT NULL,
	`count_subagent_spans` integer DEFAULT 0 NOT NULL,
	`count_errors` integer DEFAULT 0 NOT NULL,
	`count_interrupted` integer DEFAULT false NOT NULL,
	`usage_total_tokens` integer,
	`usage_input_tokens` integer,
	`usage_cached_input_tokens` integer,
	`usage_output_tokens` integer,
	`usage_reasoning_output_tokens` integer,
	`usage_model_context_window` integer,
	`usage_source` text,
	`usage_cost_usd` text,
	`source_seq_start` integer,
	`source_seq_end` integer,
	`spans_json` text,
	`spans_truncated` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_turns_thread_started_idx` ON `thread_turns` (`thread_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `thread_turns_project_completed_idx` ON `thread_turns` (`project_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `thread_turns_project_model_completed_idx` ON `thread_turns` (`project_id`,`model`,`completed_at`);--> statement-breakpoint
ALTER TABLE `threads` ADD `superseded_by_thread_id` text REFERENCES threads(id);--> statement-breakpoint
ALTER TABLE `threads` ADD `provider_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `child_kind` text;--> statement-breakpoint
CREATE INDEX `threads_superseded_idx` ON `threads` (`superseded_by_thread_id`);--> statement-breakpoint
CREATE INDEX `threads_parent_child_kind_idx` ON `threads` (`parent_thread_id`,`child_kind`) WHERE "threads"."child_kind" IS NOT NULL;