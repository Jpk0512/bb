ALTER TABLE `events` ADD `daemon_event_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `events_thread_daemon_event_idx` ON `events` (`thread_id`,`daemon_event_id`);