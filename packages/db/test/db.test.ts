import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Fill } from "@tradedeck/core";
import { eq } from "drizzle-orm";
import {
	accounts,
	type Db,
	defaultDbPath,
	fills,
	insertFills,
	openDb,
} from "../src/index.ts";

const ACCOUNT: typeof accounts.$inferSelect = {
	id: "acc-1",
	venue: "binance",
	label: "Binance demo",
	environment: "demo",
	credentialKind: "ed25519",
	createdAt: 1_761_955_200_000,
};

// Trailing zeros are deliberate: a REAL/NUMERIC column would drop them.
const SPOT_FILL: Fill = {
	accountId: "acc-1",
	instrumentId: "binance:spot:BTCUSDT",
	venueTradeId: "4012345678",
	venueOrderId: "38123456789",
	side: "buy",
	qty: "0.00012000",
	price: "109876.54000000",
	fee: "0.00000012",
	feeAsset: "BTC",
	realizedPnl: null,
	ts: 1_761_955_200_123,
};

const LINEAR_FILL: Fill = {
	accountId: "acc-1",
	instrumentId: "binance:linear:BTCUSDT",
	venueTradeId: "6512345678",
	venueOrderId: "712345678901",
	side: "sell",
	qty: "0.010",
	price: "110012.30",
	fee: "0.44004920",
	feeAsset: "USDT",
	realizedPnl: "-1.23456789",
	ts: 1_761_955_260_456,
};

let dir: string;
let path: string;
let db: Db | undefined;

/** Never call openDb() without a path here: it would create the real ~/.local/share/tradedeck. */
function open(): Db {
	db = openDb(path);
	return db;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tradedeck-db-"));
	// `nested` does not exist yet: openDb must create it.
	path = join(dir, "nested", "tradedeck.db");
});

afterEach(() => {
	db?.$client.close();
	db = undefined;
	rmSync(dir, { recursive: true, force: true });
});

test("openDb creates the directory, turns WAL on and applies migrations", () => {
	const db = open();

	expect(existsSync(path)).toBe(true);
	expect(db.$client.query("PRAGMA journal_mode").get()).toEqual({
		journal_mode: "wal",
	});
	expect(db.select().from(accounts).all()).toEqual([]);
});

test("reopening keeps data and applies no migration twice", () => {
	const first = open();
	first.insert(accounts).values(ACCOUNT).run();
	first.$client.close();

	const second = open();

	expect(second.select().from(accounts).all()).toEqual([ACCOUNT]);
});

test("an account and its fills round-trip", () => {
	const db = open();
	db.insert(accounts).values(ACCOUNT).run();

	expect(insertFills(db, [SPOT_FILL, LINEAR_FILL])).toBe(2);

	// The annotation is the compile-time check that the schema matches core's Fill.
	const rows: Fill[] = db.select().from(fills).orderBy(fills.ts).all();
	expect(rows).toEqual([SPOT_FILL, LINEAR_FILL]);
	expect(db.select().from(accounts).all()).toEqual([ACCOUNT]);
});

test("a duplicate fill is ignored, the same trade id on another instrument is not", () => {
	const db = open();
	db.insert(accounts).values(ACCOUNT).run();
	expect(insertFills(db, [SPOT_FILL])).toBe(1);

	const sameIdOtherInstrument: Fill = {
		...SPOT_FILL,
		instrumentId: "binance:linear:BTCUSDT",
	};
	expect(
		insertFills(db, [{ ...SPOT_FILL, qty: "9" }, sameIdOtherInstrument]),
	).toBe(1);

	// First write wins: the stored spot fill keeps its original qty.
	expect(db.select().from(fills).orderBy(fills.instrumentId).all()).toEqual([
		sameIdOtherInstrument,
		SPOT_FILL,
	]);
});

test("insertFills with no rows inserts nothing", () => {
	const db = open();

	expect(insertFills(db, [])).toBe(0);
	expect(db.select().from(fills).all()).toEqual([]);
});

test("deleting an account removes its fills and no other account's", () => {
	const db = open();
	db.insert(accounts)
		.values([
			ACCOUNT,
			{ ...ACCOUNT, id: "acc-2", label: "Binance live", environment: "live" },
		])
		.run();
	const otherFill: Fill = { ...LINEAR_FILL, accountId: "acc-2" };
	insertFills(db, [SPOT_FILL, otherFill]);

	db.delete(accounts).where(eq(accounts.id, "acc-1")).run();

	expect(db.select().from(fills).all()).toEqual([otherFill]);
});

test("account labels are unique", () => {
	const db = open();
	db.insert(accounts).values(ACCOUNT).run();

	expect(() =>
		db
			.insert(accounts)
			.values({ ...ACCOUNT, id: "acc-2" })
			.run(),
	).toThrow();
	expect(db.select().from(accounts).all()).toEqual([ACCOUNT]);
});

test("defaultDbPath: env override, else the documented path", () => {
	const documented = join(
		homedir(),
		".local",
		"share",
		"tradedeck",
		"tradedeck.db",
	);

	expect(defaultDbPath({ TRADEDECK_DB_PATH: "/var/tmp/td.db" })).toBe(
		"/var/tmp/td.db",
	);
	expect(defaultDbPath({})).toBe(documented);
	expect(defaultDbPath({ TRADEDECK_DB_PATH: "" })).toBe(documented);
});
