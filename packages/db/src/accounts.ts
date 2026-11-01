import { asc, eq } from "drizzle-orm";
import type { Db } from "./open.ts";
import { accounts } from "./schema.ts";

export type AccountRow = typeof accounts.$inferSelect;

/** Throws on a duplicate id or label (UNIQUE). */
export function insertAccount(db: Db, row: AccountRow): void {
	db.insert(accounts).values(row).run();
}

/** Oldest first; ties by label. */
export function listAccounts(db: Db): AccountRow[] {
	return db
		.select()
		.from(accounts)
		.orderBy(asc(accounts.createdAt), asc(accounts.label))
		.all();
}

export function findAccountByLabel(db: Db, label: string): AccountRow | null {
	return (
		db.select().from(accounts).where(eq(accounts.label, label)).get() ?? null
	);
}

/** True when a row was deleted; the account's fills cascade. */
export function deleteAccount(db: Db, id: string): boolean {
	// bun-sqlite's run() result is void, so the count comes from RETURNING.
	return (
		db
			.delete(accounts)
			.where(eq(accounts.id, id))
			.returning({ id: accounts.id })
			.all().length > 0
	);
}
