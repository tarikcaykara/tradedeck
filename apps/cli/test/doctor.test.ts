import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VenueError } from "@tradedeck/adapter";
import type { Credential, CredentialReport } from "@tradedeck/core";
import { type AccountRow, insertAccount, openDb } from "@tradedeck/db";
import type { SecretStore } from "@tradedeck/secrets";
import {
	type AccountProbe,
	type DoctorDeps,
	runDoctor,
} from "../src/doctor.ts";
import { fakeIo } from "./support/io.ts";

// Dummy values only (hard rule 1).
const API_KEY = "API-KEY-FRAGMENT";
const HMAC: Credential = {
	kind: "hmac",
	apiKey: API_KEY,
	secret: "S3CRET-FRAGMENT",
};
const DEMO: AccountRow = {
	id: "acc-1",
	venue: "binance",
	label: "binance-demo",
	environment: "demo",
	credentialKind: "hmac",
	createdAt: 1_761_955_200_000,
};
const LIVE: AccountRow = {
	...DEMO,
	id: "acc-2",
	label: "binance-live",
	environment: "live",
	createdAt: DEMO.createdAt + 1,
};
const READ_ONLY: CredentialReport = {
	canRead: true,
	canTradeSpot: false,
	canTradeDerivs: false,
	canWithdraw: false,
	canTransfer: false,
	ipRestricted: false,
};

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tradedeck-doctor-"));
	dbPath = join(dir, "tradedeck.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Writes account rows through a handle of its own, closed before doctor opens the file. */
function seed(...rows: AccountRow[]): void {
	const db = openDb(dbPath);
	for (const row of rows) insertAccount(db, row);
	db.$client.close();
}

interface ProbeOptions {
	clock?: Record<string, { offsetMs: number; accepted: boolean } | Error>;
	report?: Partial<CredentialReport> | Error;
	streams?: Record<string, Error>;
}

/** Readings for the hosts and streams `spot` and `futures`; healthy unless told otherwise. */
function fakeProbe(opts: ProbeOptions = {}): AccountProbe {
	return {
		hosts: ["spot", "futures"],
		async clockOffset(host) {
			const reading = opts.clock?.[host] ?? { offsetMs: 12, accepted: true };
			if (reading instanceof Error) throw reading;
			return reading;
		},
		async verifyCredential() {
			if (opts.report instanceof Error) throw opts.report;
			return { ...READ_ONLY, ...opts.report };
		},
		streams: ["spot", "futures"],
		async probeStream(name) {
			const failure = opts.streams?.[name];
			if (failure !== undefined) throw failure;
		},
	};
}

interface Setup {
	entries?: Record<string, Credential>;
	keychainFails?: boolean;
	openFails?: boolean;
	probe?: ProbeOptions;
}

function setup(opts: Setup = {}) {
	const { io, out } = fakeIo();
	const entries = new Map(Object.entries(opts.entries ?? {}));
	const secrets: SecretStore = {
		async get(id) {
			if (opts.keychainFails) throw new Error("keychain locked");
			return entries.get(id) ?? null;
		},
		set: async () => {
			throw new Error("doctor never writes");
		},
		delete: async () => {
			throw new Error("doctor never deletes");
		},
	};
	const probed: string[] = [];
	const deps: DoctorDeps = {
		io,
		dbPath,
		openDb: () => {
			if (opts.openFails) throw new Error("unable to open database file");
			return openDb(dbPath);
		},
		secrets,
		newProbeId: () => "probe-id",
		probe: (account) => {
			probed.push(account.label);
			return fakeProbe(opts.probe);
		},
	};
	return { deps, out, probed };
}

/** Status per check subject, e.g. `{ "[binance-demo] stream spot": "ok" }`. */
function statuses(out: readonly string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of out) {
		const match = /^(ok|FAIL|skip) +(.+?): /.exec(line);
		if (match?.[1] !== undefined && match[2] !== undefined) {
			result[match[2]] = match[1];
		}
	}
	return result;
}

const HEALTHY = {
	database: "ok",
	keychain: "ok",
	"[binance-demo] credential": "ok",
	"[binance-demo] clock spot": "ok",
	"[binance-demo] clock futures": "ok",
	"[binance-demo] permissions": "ok",
	"[binance-demo] stream spot": "ok",
	"[binance-demo] stream futures": "ok",
};

describe("doctor", () => {
	test("a healthy account passes every check: exit 0", async () => {
		seed(DEMO);
		const s = setup({ entries: { [DEMO.id]: HMAC } });
		expect(await runDoctor(s.deps)).toBe(0);
		expect(statuses(s.out)).toEqual(HEALTHY);
		expect(s.out).toContain("ok   [binance-demo] clock spot: +12 ms");
	});

	test("a missing keychain entry fails: exit 1, that account's venue checks are skipped, the next account still runs", async () => {
		seed(DEMO, LIVE);
		const s = setup({ entries: { [LIVE.id]: HMAC } });
		expect(await runDoctor(s.deps)).toBe(1);
		expect(statuses(s.out)).toMatchObject({
			"[binance-demo] credential": "FAIL",
			"[binance-demo] clock": "skip",
			"[binance-demo] permissions": "skip",
			"[binance-demo] streams": "skip",
			"[binance-live] credential": "ok",
			"[binance-live] stream futures": "ok",
		});
		expect(s.probed).toEqual(["binance-live"]);
	});

	test.each([
		["withdrawals", { canWithdraw: true }],
		["transfers", { canTransfer: true }],
		["no read permission", { canRead: false }],
	])(
		"a key with %s fails and its streams are not opened",
		async (_, report) => {
			seed(DEMO);
			const s = setup({ entries: { [DEMO.id]: HMAC }, probe: { report } });
			expect(await runDoctor(s.deps)).toBe(1);
			expect(statuses(s.out)).toMatchObject({
				"[binance-demo] permissions": "FAIL",
				"[binance-demo] stream spot": "skip",
				"[binance-demo] stream futures": "skip",
			});
		},
	);

	test("a failed credential check fails without showing the key", async () => {
		seed(DEMO);
		const echo = new VenueError({
			kind: "http",
			method: "GET",
			path: "/api/v3/account",
			status: 401,
			code: "-2015",
			retryAfterMs: null,
			text: `Invalid API-key ${API_KEY}, IP, or permissions for action.`,
		});
		const s = setup({
			entries: { [DEMO.id]: HMAC },
			probe: { report: echo, streams: { spot: echo } },
		});
		expect(await runDoctor(s.deps)).toBe(1);
		expect(statuses(s.out)).toMatchObject({
			"[binance-demo] permissions": "FAIL",
			"[binance-demo] stream spot": "skip",
		});
		expect(s.out.join("\n")).not.toContain(API_KEY);
		expect(s.out.join("\n")).toContain("[redacted]");
	});

	test("a clock outside the recvWindow fails; the other checks still run", async () => {
		seed(DEMO);
		const s = setup({
			entries: { [DEMO.id]: HMAC },
			probe: { clock: { futures: { offsetMs: -1500, accepted: false } } },
		});
		expect(await runDoctor(s.deps)).toBe(1);
		expect(statuses(s.out)).toEqual({
			...HEALTHY,
			"[binance-demo] clock futures": "FAIL",
		});
	});

	test("a stream that does not come up fails with its reason", async () => {
		seed(DEMO);
		const s = setup({
			entries: { [DEMO.id]: HMAC },
			probe: { streams: { futures: new Error("not up within 15 s") } },
		});
		expect(await runDoctor(s.deps)).toBe(1);
		expect(statuses(s.out)).toEqual({
			...HEALTHY,
			"[binance-demo] stream futures": "FAIL",
		});
		expect(s.out).toContain(
			"FAIL [binance-demo] stream futures: not up within 15 s",
		);
	});

	test("an unreachable keychain fails and the accounts are skipped", async () => {
		seed(DEMO);
		const s = setup({ keychainFails: true });
		expect(await runDoctor(s.deps)).toBe(1);
		expect(statuses(s.out)).toEqual({
			database: "ok",
			keychain: "FAIL",
			accounts: "skip",
		});
		expect(s.probed).toEqual([]);
	});

	test("a database that cannot be opened fails; the keychain is still checked", async () => {
		const s = setup({ openFails: true });
		expect(await runDoctor(s.deps)).toBe(1);
		expect(statuses(s.out)).toEqual({
			database: "FAIL",
			keychain: "ok",
			accounts: "skip",
		});
	});

	test("a database migrated by a newer build fails", async () => {
		const db = openDb(dbPath);
		db.$client.run(
			"INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('newer', ?)",
			[Number.MAX_SAFE_INTEGER],
		);
		db.$client.close();
		const s = setup();
		expect(await runDoctor(s.deps)).toBe(1);
		expect(statuses(s.out)).toEqual({
			database: "FAIL",
			keychain: "ok",
			accounts: "skip",
		});
	});

	test("no accounts is not a failure", async () => {
		const s = setup();
		expect(await runDoctor(s.deps)).toBe(0);
		expect(statuses(s.out)).toEqual({
			database: "ok",
			keychain: "ok",
			accounts: "skip",
		});
	});
});
