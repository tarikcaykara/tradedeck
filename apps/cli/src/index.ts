/**
 * `bun run cli -- <command>` (docs/architecture.md §9). The only process that
 * reads a credential from the user; it reaches the OS keychain and nothing else
 * (hard rule 1).
 */
import { createBinanceAdapter } from "@tradedeck/binance";
import { openDb } from "@tradedeck/db";
import { createKeychainSecretStore } from "@tradedeck/secrets";
import { runCli } from "./cli.ts";
import { generateEd25519KeyPair } from "./ed25519.ts";
import { clackIo } from "./io.ts";

const io = clackIo();
// Explicit exit: clack may keep stdin referenced.
process.exit(
	await runCli(process.argv.slice(2), io, () => ({
		io,
		db: openDb(),
		secrets: createKeychainSecretStore(),
		verifyCredential: (account, credential) =>
			createBinanceAdapter({
				accountId: account.id,
				environment: account.environment,
				credential,
			}).verifyCredential(),
		generateEd25519KeyPair,
		newAccountId: () => crypto.randomUUID(),
		now: Date.now,
	})),
);
