/**
 * `keys add | list | remove` (docs/architecture.md §9). The credential is read
 * from hidden prompts, lives in this process only, and is written to the OS
 * keychain alone; no output line carries it (hard rule 1).
 */
import type {
	Credential,
	CredentialReport,
	Environment,
	Venue,
} from "@tradedeck/core";
import {
	type Db,
	deleteAccount,
	findAccountByLabel,
	insertAccount,
	listAccounts,
} from "@tradedeck/db";
import type { SecretStore } from "@tradedeck/secrets";
import type { Ed25519KeyPair } from "./ed25519.ts";
import type { Io } from "./io.ts";

export interface KeysDeps {
	io: Io;
	db: Db;
	secrets: SecretStore;
	verifyCredential(
		account: { id: string; venue: Venue; environment: Environment },
		credential: Credential,
	): Promise<CredentialReport>;
	generateEd25519KeyPair(): Ed25519KeyPair;
	newAccountId(): string;
	now(): number;
}

export interface KeysAddArgs {
	venue: Venue;
	environment: Environment;
	label: string;
	kind: Credential["kind"];
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * The error's message with every credential value cut out: a venue or the
 * keychain may echo what it was given (hard rule 1). PEM body lines are cut one
 * by one too, since an error may quote the key JSON-escaped.
 */
function redactedMessage(e: unknown, credential: Credential): string {
	const values =
		credential.kind === "hmac"
			? [credential.apiKey, credential.secret]
			: [
					credential.apiKey,
					credential.privateKeyPem,
					...credential.privateKeyPem
						.split("\n")
						.filter((line) => !line.startsWith("-----")),
				];
	let text = message(e);
	for (const value of values) {
		// replaceAll("") would insert the marker between every character.
		if (value !== "") text = text.replaceAll(value, "[redacted]");
	}
	return text;
}

const SITES: Record<Environment, string> = {
	live: "binance.com",
	demo: "demo.binance.com",
};

/** Reads the credential from hidden prompts; null when the user cancels. */
async function readCredential(
	deps: KeysDeps,
	kind: Credential["kind"],
	site: string,
): Promise<Credential | null> {
	const { io } = deps;
	if (kind === "ed25519") {
		const pair = deps.generateEd25519KeyPair();
		io.step(
			`On ${site} → API Management, create a Self-generated API key with this public key. Enable Reading only.`,
		);
		io.print(`\n${pair.publicKeyPem}`);
		const apiKey = await io.secret("API key");
		if (apiKey === null) return null;
		return { kind, apiKey, privateKeyPem: pair.privateKeyPem };
	}
	io.step(
		`On ${site} → API Management, create a System-generated API key. Enable Reading only.`,
	);
	const apiKey = await io.secret("API key");
	if (apiKey === null) return null;
	const secret = await io.secret("Secret key");
	if (secret === null) return null;
	return { kind, apiKey, secret };
}

function formatReport(report: CredentialReport): string {
	const rows: [string, boolean][] = [
		["read", report.canRead],
		["spot trading", report.canTradeSpot],
		["futures trading", report.canTradeDerivs],
		["withdrawals", report.canWithdraw],
		["transfers", report.canTransfer],
		["IP restricted", report.ipRestricted],
	];
	return [
		"Credential check",
		...rows.map(([name, on]) => `  ${name.padEnd(17)}${on ? "yes" : "no"}`),
	].join("\n");
}

/**
 * The account row is written before the keychain entry and deleted again if
 * the keychain write fails, so neither outlives the other (docs/decisions.md).
 */
export async function keysAdd(
	deps: KeysDeps,
	args: KeysAddArgs,
): Promise<number> {
	const { io, db } = deps;
	const { venue, environment, label } = args;
	// Before key generation, so no venue key is created in vain.
	if (findAccountByLabel(db, label) !== null) {
		io.error(`An account labelled "${label}" already exists.`);
		return 1;
	}
	const site = SITES[environment];
	const credential = await readCredential(deps, args.kind, site);
	if (credential === null) {
		io.warn("Cancelled; nothing was stored.");
		return 1;
	}

	const id = deps.newAccountId();
	let report: CredentialReport;
	try {
		report = await deps.verifyCredential(
			{ id, venue, environment },
			credential,
		);
	} catch (e) {
		io.error(
			`Credential check failed; nothing was stored: ${redactedMessage(e, credential)}`,
		);
		return 1;
	}
	io.print(formatReport(report));
	// Hard rule 2; the other flags are informational.
	if (report.canWithdraw || report.canTransfer) {
		const perms =
			report.canWithdraw && report.canTransfer
				? "withdrawal and transfer"
				: report.canWithdraw
					? "withdrawal"
					: "transfer";
		io.error(
			`Refused: this key has ${perms} permission. Delete it on ${site} and create one without; nothing was stored.`,
		);
		return 1;
	}

	try {
		insertAccount(db, {
			id,
			venue,
			label,
			environment,
			credentialKind: credential.kind,
			createdAt: deps.now(),
		});
	} catch (e) {
		io.error(`Could not save the account; nothing was stored: ${message(e)}`);
		return 1;
	}
	try {
		await deps.secrets.set(id, credential);
	} catch (e) {
		// A throw here propagates; `keys remove` clears the orphan row.
		deleteAccount(db, id);
		io.error(
			`Could not store the key in the keychain; the account was not added: ${redactedMessage(e, credential)}`,
		);
		return 1;
	}
	io.success(`Added ${label} (${venue} ${environment}, ${credential.kind}).`);
	return 0;
}

/** Never shows key material: the database holds none. */
export function keysList(deps: Pick<KeysDeps, "io" | "db">): number {
	const rows = listAccounts(deps.db);
	if (rows.length === 0) {
		deps.io.print("No accounts.");
		return 0;
	}
	const header = ["label", "venue", "environment", "kind", "created"];
	const table = [
		header,
		...rows.map((r) => [
			r.label,
			r.venue,
			r.environment,
			r.credentialKind,
			new Date(r.createdAt).toISOString(),
		]),
	];
	const widths = header.map((_, i) =>
		Math.max(...table.map((row) => row[i]?.length ?? 0)),
	);
	deps.io.print(
		table
			.map((row) =>
				row
					.map((cell, i) => cell.padEnd((widths[i] ?? 0) + 2))
					.join("")
					.trimEnd(),
			)
			.join("\n"),
	);
	return 0;
}

/**
 * The keychain entry goes first: when it cannot be deleted the account stays,
 * so the command can be retried. A missing entry is not an error.
 */
export async function keysRemove(
	deps: Pick<KeysDeps, "io" | "db" | "secrets">,
	label: string,
): Promise<number> {
	const { io, db } = deps;
	const row = findAccountByLabel(db, label);
	if (row === null) {
		io.error(`No account labelled "${label}".`);
		return 1;
	}
	const answer = await io.text(
		`Type "${label}" to delete this account, its keychain entry and its stored fills`,
	);
	if (answer === null) {
		io.warn("Cancelled; nothing was deleted.");
		return 1;
	}
	if (answer.trim() !== label) {
		io.error("The label did not match; nothing was deleted.");
		return 1;
	}
	let hadKey: boolean;
	try {
		hadKey = await deps.secrets.delete(row.id);
	} catch (e) {
		io.error(
			`Could not delete the keychain entry; nothing was deleted: ${message(e)}`,
		);
		return 1;
	}
	deleteAccount(db, row.id);
	io.success(
		hadKey
			? `Removed ${label}.`
			: `Removed ${label}; it had no keychain entry.`,
	);
	return 0;
}
