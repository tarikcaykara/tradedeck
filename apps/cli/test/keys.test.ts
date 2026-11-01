import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VenueError } from "@tradedeck/adapter";
import type { Credential, CredentialReport } from "@tradedeck/core";
import {
	type AccountRow,
	type Db,
	insertAccount,
	listAccounts,
	openDb,
} from "@tradedeck/db";
import {
	createKeychainSecretStore,
	type KeychainBackend,
} from "@tradedeck/secrets";
import { runCli, USAGE } from "../src/cli.ts";
import type { Io } from "../src/io.ts";
import {
	type KeysAddArgs,
	type KeysDeps,
	keysAdd,
	keysList,
	keysRemove,
} from "../src/keys.ts";

// Dummy values only (hard rule 1). The PEM is the RFC 8032 §7.1 TEST 2 key
// from packages/adapter/test/signer.test.ts.
const API_KEY = "API-KEY-FRAGMENT";
const HMAC_SECRET = "S3CRET-FRAGMENT";
const PRIVATE_BODY =
	"MC4CAQAwBQYDK2VwBCIEIEzNCJso/5banbbDRuwRTg9bijGfNaumJNqM9u1PuKb7";
const RFC8032_PEM = [
	"-----BEGIN PRIVATE KEY-----",
	PRIVATE_BODY,
	"-----END PRIVATE KEY-----",
].join("\n");
const PAIR = {
	privateKeyPem: RFC8032_PEM,
	publicKeyPem: createPublicKey(RFC8032_PEM)
		.export({ type: "spki", format: "pem" })
		.toString(),
};

const LABEL = "binance-demo";
const CREATED_AT = 1_761_955_200_000;
const ED25519: Credential = {
	kind: "ed25519",
	apiKey: API_KEY,
	privateKeyPem: RFC8032_PEM,
};
const HMAC: Credential = { kind: "hmac", apiKey: API_KEY, secret: HMAC_SECRET };
const ROW: AccountRow = {
	id: "acc-1",
	venue: "binance",
	label: LABEL,
	environment: "demo",
	credentialKind: "hmac",
	createdAt: CREATED_AT,
};

const READ_ONLY_REPORT: CredentialReport = {
	canRead: true,
	canTradeSpot: false,
	canTradeDerivs: false,
	canWithdraw: false,
	canTransfer: false,
	ipRestricted: false,
};

let dir: string;
let db: Db;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tradedeck-cli-"));
	db = openDb(join(dir, "tradedeck.db"));
});

afterEach(() => {
	db.$client.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Captures every line shown or asked; answers come from a queue, empty = cancel. */
function fakeIo(answers: readonly string[] = []) {
	const out: string[] = [];
	const queue = [...answers];
	const show = (text: string) => {
		out.push(text);
	};
	const ask = async (message: string) => {
		out.push(message);
		return queue.shift() ?? null;
	};
	const io: Io = {
		print: show,
		step: show,
		success: show,
		warn: show,
		error: show,
		secret: ask,
		text: ask,
	};
	return { io, out, queue };
}

/**
 * In-memory stand-in with `Bun.secrets` semantics, keyed `${service}/${name}`.
 * A failing `set` echoes the value it was given: the worst case for output.
 */
function fakeKeychain(fail: { set?: boolean; delete?: boolean } = {}) {
	const entries = new Map<string, string>();
	const backend: KeychainBackend = {
		get: async ({ service, name }) => entries.get(`${service}/${name}`) ?? null,
		set: async ({ service, name, value }) => {
			if (fail.set) throw new Error(`keychain locked; not stored: ${value}`);
			entries.set(`${service}/${name}`, value);
		},
		delete: async ({ service, name }) => {
			if (fail.delete) throw new Error("keychain locked");
			return entries.delete(`${service}/${name}`);
		},
	};
	return { entries, secrets: createKeychainSecretStore({ backend }) };
}

interface Setup {
	answers?: readonly string[];
	report?: Partial<CredentialReport>;
	verifyFails?: boolean;
	keychainFails?: { set?: boolean; delete?: boolean };
}

function setup(opts: Setup = {}) {
	const { io, out, queue } = fakeIo(opts.answers);
	const { entries, secrets } = fakeKeychain(opts.keychainFails);
	const verified: Parameters<KeysDeps["verifyCredential"]>[] = [];
	const deps: KeysDeps = {
		io,
		db,
		secrets,
		verifyCredential: async (...args) => {
			verified.push(args);
			if (opts.verifyFails) {
				// Echoes the API key: the worst case for output.
				throw new VenueError({
					kind: "http",
					method: "GET",
					path: "/api/v3/account",
					status: 401,
					code: "-2015",
					retryAfterMs: null,
					text: `Invalid API-key ${args[1].apiKey}, IP, or permissions for action.`,
				});
			}
			return { ...READ_ONLY_REPORT, ...opts.report };
		},
		generateEd25519KeyPair: () => PAIR,
		newAccountId: () => "acc-1",
		now: () => CREATED_AT,
	};
	return { deps, out, queue, entries, secrets, verified };
}

function addArgs(kind: Credential["kind"]): KeysAddArgs {
	return { venue: "binance", environment: "demo", label: LABEL, kind };
}

const ADDS = [
	["ed25519", [API_KEY], ED25519],
	["hmac", [API_KEY, HMAC_SECRET], HMAC],
] as const;

describe("keys add", () => {
	test.each(ADDS)(
		"stores a verified %s key: one account row and its keychain entry",
		async (kind, answers, credential) => {
			const s = setup({ answers });
			expect(await keysAdd(s.deps, addArgs(kind))).toBe(0);
			expect(listAccounts(db)).toEqual([{ ...ROW, credentialKind: kind }]);
			expect(await s.secrets.get("acc-1")).toEqual(credential);
			expect(s.verified).toEqual([
				[{ id: "acc-1", venue: "binance", environment: "demo" }, credential],
			]);
		},
	);

	test.each([
		["withdrawal", { canWithdraw: true }],
		["transfer", { canTransfer: true }],
		["withdrawal and transfer", { canWithdraw: true, canTransfer: true }],
	])(
		"refuses a key with %s permission and stores nothing",
		async (_perms, report) => {
			const s = setup({ answers: [API_KEY], report });
			expect(await keysAdd(s.deps, addArgs("ed25519"))).toBe(1);
			expect(listAccounts(db)).toEqual([]);
			expect(s.entries.size).toBe(0);
		},
	);

	test("a failed credential check stores nothing", async () => {
		const s = setup({ answers: [API_KEY], verifyFails: true });
		expect(await keysAdd(s.deps, addArgs("ed25519"))).toBe(1);
		expect(listAccounts(db)).toEqual([]);
		expect(s.entries.size).toBe(0);
	});

	test("a failed keychain write rolls the account row back", async () => {
		const s = setup({ answers: [API_KEY], keychainFails: { set: true } });
		expect(await keysAdd(s.deps, addArgs("ed25519"))).toBe(1);
		expect(listAccounts(db)).toEqual([]);
		expect(s.entries.size).toBe(0);
	});

	test("a taken label is refused before any key is generated or asked for", async () => {
		const existing: AccountRow = { ...ROW, id: "acc-0", createdAt: 1 };
		insertAccount(db, existing);
		const s = setup({ answers: [API_KEY] });
		expect(await keysAdd(s.deps, addArgs("ed25519"))).toBe(1);
		expect(s.verified).toEqual([]);
		expect(s.queue).toEqual([API_KEY]);
		expect(listAccounts(db)).toEqual([existing]);
	});

	test.each([
		["ed25519", "API key", []],
		["hmac", "secret", [API_KEY]],
	] as const)(
		"cancelling the %s %s prompt stores nothing and checks nothing",
		async (kind, _prompt, answers) => {
			const s = setup({ answers });
			expect(await keysAdd(s.deps, addArgs(kind))).toBe(1);
			expect(s.verified).toEqual([]);
			expect(listAccounts(db)).toEqual([]);
			expect(s.entries.size).toBe(0);
		},
	);
});

describe("output never shows key material", () => {
	test.each([
		["ed25519 add", "ed25519", { answers: [API_KEY] }],
		["hmac add", "hmac", { answers: [API_KEY, HMAC_SECRET] }],
		[
			"withdrawal refusal",
			"hmac",
			{ answers: [API_KEY, HMAC_SECRET], report: { canWithdraw: true } },
		],
		[
			"failed check echoing the API key",
			"ed25519",
			{ answers: [API_KEY], verifyFails: true },
		],
		[
			"keychain failure echoing the stored ed25519 key",
			"ed25519",
			{ answers: [API_KEY], keychainFails: { set: true } },
		],
		[
			"keychain failure echoing the stored hmac key",
			"hmac",
			{ answers: [API_KEY, HMAC_SECRET], keychainFails: { set: true } },
		],
	] as const)("%s, then keys list", async (_name, kind, opts: Setup) => {
		const s = setup(opts);
		await keysAdd(s.deps, addArgs(kind));
		keysList(s.deps);
		const output = s.out.join("\n");
		expect(output).not.toContain(API_KEY);
		expect(output).not.toContain(HMAC_SECRET);
		expect(output).not.toContain(PRIVATE_BODY);
		// Proves the capture sees printed output.
		if (kind === "ed25519") expect(output).toContain(PAIR.publicKeyPem);
	});
});

describe("keys list", () => {
	test("lists accounts oldest first", async () => {
		insertAccount(db, {
			...ROW,
			id: "acc-2",
			label: "newer",
			createdAt: 2_000,
		});
		insertAccount(db, {
			...ROW,
			id: "acc-1",
			label: "older",
			createdAt: 1_000,
		});
		const s = setup();
		expect(keysList(s.deps)).toBe(0);
		const output = s.out.join("\n");
		expect(output).toContain("newer");
		expect(output.indexOf("older")).toBeGreaterThan(-1);
		expect(output.indexOf("older")).toBeLessThan(output.indexOf("newer"));
	});
});

describe("keys remove", () => {
	test("deletes the keychain entry and the account once the label is typed", async () => {
		const s = setup({ answers: [LABEL] });
		insertAccount(db, ROW);
		await s.secrets.set("acc-1", HMAC);
		expect(await keysRemove(s.deps, LABEL)).toBe(0);
		expect(listAccounts(db)).toEqual([]);
		expect(await s.secrets.get("acc-1")).toBeNull();
	});

	test.each([
		["a different label", ["binance-dem"]],
		["a cancelled confirmation", []],
	] as const)("%s keeps the account and its key", async (_name, answers) => {
		const s = setup({ answers });
		insertAccount(db, ROW);
		await s.secrets.set("acc-1", HMAC);
		expect(await keysRemove(s.deps, LABEL)).toBe(1);
		expect(listAccounts(db)).toEqual([ROW]);
		expect(await s.secrets.get("acc-1")).toEqual(HMAC);
	});

	test("an unknown label fails", async () => {
		const s = setup({ answers: ["nope"] });
		expect(await keysRemove(s.deps, "nope")).toBe(1);
	});

	test("an account without a keychain entry is still removed", async () => {
		const s = setup({ answers: [LABEL] });
		insertAccount(db, ROW);
		expect(await keysRemove(s.deps, LABEL)).toBe(0);
		expect(listAccounts(db)).toEqual([]);
	});

	test("a failed keychain delete keeps the account, so a retry works", async () => {
		const s = setup({ answers: [LABEL], keychainFails: { delete: true } });
		insertAccount(db, ROW);
		await s.secrets.set("acc-1", HMAC);
		expect(await keysRemove(s.deps, LABEL)).toBe(1);
		expect(listAccounts(db)).toEqual([ROW]);
	});
});

describe("runCli", () => {
	test.each<[string[]]>([
		[["keys", "add", "--venue", "binance", "--env", "prod", "--label", "x"]],
		[["keys", "add", "--venue", "binance", "--env", "demo"]],
		[["keys", "remove"]],
		[["keys", "frobnicate"]],
		[[]],
	])("rejects %p with the usage and opens nothing", async (argv) => {
		const { io, out } = fakeIo();
		let opened = 0;
		const exit = await runCli(argv, io, () => {
			opened++;
			throw new Error("opened");
		});
		expect(exit).toBe(1);
		expect(opened).toBe(0);
		expect(out).toContain(USAGE);
	});
});
