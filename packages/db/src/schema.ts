import type {
	Credential,
	Environment,
	InstrumentId,
	OrderSide,
	Venue,
} from "@tradedeck/core";
import {
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

// docs/architecture.md §10. Decimal columns are TEXT (hard rule 4): SQLite
// stores the venue's string as given, trailing zeros included.

export const accounts = sqliteTable("accounts", {
	id: text("id").primaryKey(),
	venue: text("venue").$type<Venue>().notNull(),
	label: text("label").notNull().unique(),
	environment: text("environment").$type<Environment>().notNull(),
	credentialKind: text("credential_kind").$type<Credential["kind"]>().notNull(),
	/** Milliseconds since the Unix epoch, supplied by the caller. */
	createdAt: integer("created_at").notNull(),
});

export const fills = sqliteTable(
	"fills",
	{
		accountId: text("account_id")
			.notNull()
			.references(() => accounts.id, { onDelete: "cascade" }),
		instrumentId: text("instrument_id").$type<InstrumentId>().notNull(),
		venueTradeId: text("venue_trade_id").notNull(),
		venueOrderId: text("venue_order_id").notNull(),
		side: text("side").$type<OrderSide>().notNull(),
		qty: text("qty").notNull(),
		price: text("price").notNull(),
		fee: text("fee").notNull(),
		feeAsset: text("fee_asset").notNull(),
		realizedPnl: text("realized_pnl"),
		ts: integer("ts").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.accountId, t.instrumentId, t.venueTradeId] }),
	],
);
