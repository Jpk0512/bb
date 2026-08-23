CREATE TABLE `pending_parent_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_thread_id` text NOT NULL,
	`child_thread_id` text NOT NULL,
	`child_project_id` text NOT NULL,
	`child_title` text,
	`turn_status` text NOT NULL,
	`active_workflow_count` integer DEFAULT 0 NOT NULL,
	`terminal_output` text,
	`inbox_emitted_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`last_error` text,
	`deliver_after` integer NOT NULL,
	`claimed_at` integer,
	`claim_token` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_parent_notifications_due_idx` ON `pending_parent_notifications` (`deliver_after`,`parent_thread_id`);--> statement-breakpoint
CREATE INDEX `pending_parent_notifications_parent_idx` ON `pending_parent_notifications` (`parent_thread_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `app_settings` ADD `disabled_models` text DEFAULT '[]' NOT NULL;