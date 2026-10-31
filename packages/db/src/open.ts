import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
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
