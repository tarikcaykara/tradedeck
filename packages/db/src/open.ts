import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

declare module "bun" {
	interface Env {
		/** docs/architecture.md §10: overrides the default database path. */
		TRADEDECK_DB_PATH?: string;
	}
}

export type Db = BunSQLiteDatabase & { $client: Database };

const MIGRATIONS_DIR = join(import.meta.dir, "..", "drizzle");

/** `TRADEDECK_DB_PATH` when set and non-empty, else `~/.local/share/tradedeck/tradedeck.db`. */
export function defaultDbPath(env: Bun.Env = process.env): string {
	return (
		env.TRADEDECK_DB_PATH ||
		join(homedir(), ".local", "share", "tradedeck", "tradedeck.db")
	);
}

/**
 * Opens (creating if needed) the database, turns on WAL and foreign keys and
 * applies pending migrations. A failed migration closes the handle and throws:
 * nothing runs on a half-migrated database. Close with `db.$client.close()`.
 */
export function openDb(path: string = defaultDbPath()): Db {
	mkdirSync(dirname(path), { recursive: true });
	const sqlite = new Database(path);
	try {
		sqlite.run("PRAGMA journal_mode = WAL;");
		// Off by default per connection; without it ON DELETE CASCADE is inert.
		// Must run outside a transaction, so before migrate().
		sqlite.run("PRAGMA foreign_keys = ON;");
		const db = drizzle({ client: sqlite });
		migrate(db, { migrationsFolder: MIGRATIONS_DIR });
		return db;
	} catch (error) {
		sqlite.close();
		throw error;
	}
}

/**
 * The migrations recorded in the database against the ones this build ships.
 * `openDb` applies every pending one, so nothing is behind after it; a
 * database migrated by a newer build is `ahead`, which the migrator accepts
 * without a word (it only applies what is newer than its last row).
 */
export function migrationStatus(db: Db): {
	applied: number;
	shipped: number;
	ahead: boolean;
} {
	const journal: unknown = JSON.parse(
		readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
	);
	const shipped = journalTimes(journal);
	const latest = Math.max(...shipped);
	const rows = db.$client
		.query<{ created_at: number }, []>(
			"SELECT created_at FROM __drizzle_migrations",
		)
		.all();
	return {
		applied: rows.length,
		shipped: shipped.length,
		ahead: rows.some((row) => Number(row.created_at) > latest),
	};
}

/** The `when` of every journal entry; drizzle-kit writes the file, so a bad one is a broken build. */
function journalTimes(journal: unknown): number[] {
	const entries =
		typeof journal === "object" && journal !== null && "entries" in journal
			? journal.entries
			: null;
	const times = Array.isArray(entries)
		? entries.map((e: unknown) =>
				typeof e === "object" && e !== null && "when" in e ? e.when : null,
			)
		: [];
	if (times.length === 0 || !times.every((t) => typeof t === "number")) {
		throw new Error("db: the migration journal is unreadable");
	}
	return times;
}
