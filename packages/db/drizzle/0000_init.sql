CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`venue` text NOT NULL,
	`label` text NOT NULL,
	`environment` text NOT NULL,
	`credential_kind` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_label_unique` ON `accounts` (`label`);--> statement-breakpoint
CREATE TABLE `fills` (
	`account_id` text NOT NULL,
	`instrument_id` text NOT NULL,
	`venue_trade_id` text NOT NULL,
	`venue_order_id` text NOT NULL,
	`side` text NOT NULL,
	`qty` text NOT NULL,
	`price` text NOT NULL,
	`fee` text NOT NULL,
	`fee_asset` text NOT NULL,
	`realized_pnl` text,
	`ts` integer NOT NULL,
	PRIMARY KEY(`account_id`, `instrument_id`, `venue_trade_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
