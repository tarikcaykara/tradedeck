/**
 * `doctor` (docs/architecture.md §9): one line per check, exit 1 when any
 * check fails. It writes no key and places no order; opening the database
 * applies pending migrations, and the futures stream check extends the active
 * listen key. No output line carries key material (hard rule 1).
 */
import type { Credential, CredentialReport } from "@tradedeck/core";
import {
	type AccountRow,
	type Db,
	listAccounts,
	migrationStatus,
} from "@tradedeck/db";
import type { SecretStore } from "@tradedeck/secrets";
import type { Io } from "./io.ts";
import { message, redactedMessage } from "./redact.ts";

/**
 * Venue readings for one account. Every method rejects on failure; `doctor`
 * judges the permissions itself.
 */
export interface AccountProbe<Name extends string = string> {
	/** The hosts whose clock is read, e.g. `spot` and `futures`. */
	readonly hosts: readonly Name[];
	/**
	 * Server minus local time in ms; `accepted` when a request stamped with the
	 * local clock alone would pass the venue's window.
	 */
	clockOffset(host: Name): Promise<{ offsetMs: number; accepted: boolean }>;
	verifyCredential(): Promise<CredentialReport>;
	/** The private streams, e.g. `spot` and `futures`. */
	readonly streams: readonly Name[];
	/** Resolves once the stream is up; it is closed either way. */
	probeStream(name: Name): Promise<void>;
}

export interface DoctorDeps {
	io: Io;
	/** Shown on the database line. */
	dbPath: string;
	/** Throws when the database cannot be opened or migrated. */
	openDb(): Db;
	secrets: SecretStore;
	/** An id no account has: the keychain check reads it and expects nothing. */
	newProbeId(): string;
	probe(account: AccountRow, credential: Credential): AccountProbe;
}

type Status = "ok" | "FAIL" | "skip";
type Line = [status: Status, subject: string, detail: string];
type Report = (...line: Line) => void;

/** Returns the exit code. */
export async function runDoctor(deps: DoctorDeps): Promise<number> {
	let checks = 0;
	let failed = 0;
	const report: Report = (status, subject, detail) => {
		if (status !== "skip") checks++;
		if (status === "FAIL") failed++;
		deps.io.print(`${status.padEnd(4)} ${subject}: ${detail}`);
	};

	const database = checkDatabase(deps, report);
	try {
		const keychain = await checkKeychain(deps, report);
		if (!database.ok || !keychain) {
			report(
				"skip",
				"accounts",
				database.ok
					? "the keychain is unreachable"
					: "the database is unusable",
			);
		} else {
			const accounts = listAccounts(database.db);
			if (accounts.length === 0) {
				report(
					"skip",
					"accounts",
					"none; add one with bun run cli -- keys add",
				);
			}
			for (const account of accounts) {
				await checkAccount(deps, account, report);
			}
		}
	} finally {
		database.db?.$client.close();
	}

	deps.io.print(
		failed === 0
			? `doctor: all ${checks} checks passed`
			: `doctor: ${failed} of ${checks} checks failed`,
	);
	return failed === 0 ? 0 : 1;
}

/** `db` is set whenever the file opened, so the caller closes it. */
function checkDatabase(
	deps: DoctorDeps,
	report: Report,
): { ok: true; db: Db } | { ok: false; db: Db | null } {
	let db: Db;
	try {
		db = deps.openDb();
	} catch (e) {
		report("FAIL", "database", `${deps.dbPath}: ${message(e)}`);
		return { ok: false, db: null };
	}
	try {
		const status = migrationStatus(db);
		if (status.ahead) {
			report(
				"FAIL",
				"database",
				`${deps.dbPath} was migrated by a newer tradedeck build`,
			);
			return { ok: false, db };
		}
		report(
			"ok",
			"database",
			`${deps.dbPath} (${status.applied} of ${status.shipped} migrations)`,
		);
		return { ok: true, db };
	} catch (e) {
		report("FAIL", "database", `${deps.dbPath}: ${message(e)}`);
		return { ok: false, db };
	}
}

async function checkKeychain(
	deps: DoctorDeps,
	report: Report,
): Promise<boolean> {
	try {
		await deps.secrets.get(deps.newProbeId());
		report("ok", "keychain", "reachable");
		return true;
	} catch (e) {
		report("FAIL", "keychain", message(e));
		return false;
	}
}

/**
 * Clocks first: they need no permission and can explain a credential failure.
 * Streams last, and only for a key that reads and cannot move funds.
 */
async function checkAccount(
	deps: DoctorDeps,
	account: AccountRow,
	report: Report,
): Promise<void> {
	const at = (check: string) => `[${account.label}] ${check}`;

	let credential: Credential | null = null;
	let lookupError: string | null = null;
	try {
		credential = await deps.secrets.get(account.id);
	} catch (e) {
		lookupError = message(e);
	}
	if (credential === null) {
		report(
			"FAIL",
			at("credential"),
			lookupError ??
				`no keychain entry; run keys remove ${account.label}, then keys add`,
		);
		for (const check of ["clock", "permissions", "streams"]) {
			report("skip", at(check), "needs the credential");
		}
		return;
	}
	const key = credential;
	report("ok", at("credential"), `in the keychain (${key.kind})`);
	const probe = deps.probe(account, key);

	const clocks = await Promise.all(
		probe.hosts.map(async (host): Promise<Line> => {
			try {
				const { offsetMs, accepted } = await probe.clockOffset(host);
				const shown = `${offsetMs >= 0 ? "+" : ""}${offsetMs} ms`;
				return accepted
					? ["ok", at(`clock ${host}`), shown]
					: [
							"FAIL",
							at(`clock ${host}`),
							`${shown}, outside the venue's recvWindow; fix the system clock`,
						];
			} catch (e) {
				return ["FAIL", at(`clock ${host}`), redactedMessage(e, key)];
			}
		}),
	);
	for (const line of clocks) report(...line);

	let refusal: string | null;
	try {
		const permissions = await probe.verifyCredential();
		refusal = refusalOf(permissions);
		report(
			refusal === null ? "ok" : "FAIL",
			at("permissions"),
			refusal ?? describe(permissions),
		);
	} catch (e) {
		refusal = redactedMessage(e, key);
		report("FAIL", at("permissions"), refusal);
	}
	if (refusal !== null) {
		for (const name of probe.streams) {
			report("skip", at(`stream ${name}`), "the permissions check failed");
		}
		return;
	}

	const streams = await Promise.all(
		probe.streams.map(async (name): Promise<Line> => {
			try {
				await probe.probeStream(name);
				return ["ok", at(`stream ${name}`), "up"];
			} catch (e) {
				return ["FAIL", at(`stream ${name}`), redactedMessage(e, key)];
			}
		}),
	);
	for (const line of streams) report(...line);
}

/** Why the key must not be used, or null. Withdrawals and transfers: hard rule 2. */
function refusalOf(r: CredentialReport): string | null {
	if (!r.canRead) return "the key cannot read";
	if (r.canWithdraw)
		return "the key allows withdrawals; remove it and add a read-only key";
	if (r.canTransfer)
		return "the key allows transfers; remove it and add a read-only key";
	return null;
}

function describe(r: CredentialReport): string {
	const yn = (on: boolean) => (on ? "yes" : "no");
	return [
		"read yes",
		`spot trading ${yn(r.canTradeSpot)}`,
		`futures trading ${yn(r.canTradeDerivs)}`,
		"withdrawals no",
		"transfers no",
		`IP restricted ${yn(r.ipRestricted)}`,
	].join(", ");
}
