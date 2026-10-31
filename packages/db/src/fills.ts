import type { Fill } from "@tradedeck/core";
import type { Db } from "./open.ts";
import { fills } from "./schema.ts";

/**
 * Adds fills to the ledger. A fill already stored under the same
 * (account, instrument, venue trade id) is skipped, never overwritten:
 * venue trades are immutable, and trade ids are unique per instrument only.
 * Returns how many fills were new. Callers pass one venue page at a time.
 */
export function insertFills(db: Db, rows: Fill[]): number {
	// Drizzle's values([]) throws.
	if (rows.length === 0) return 0;
	// bun-sqlite's run() result is void, so the count comes from RETURNING.
	return db
		.insert(fills)
		.values(rows)
		.onConflictDoNothing()
		.returning({ venueTradeId: fills.venueTradeId })
		.all().length;
}
