import { type Credential, CredentialSchema } from "@tradedeck/core";
import type { SecretStore } from "./store.ts";

/** The slice of `Bun.secrets` the store uses; tests inject an in-memory fake. */
export interface KeychainBackend {
	get(entry: { service: string; name: string }): Promise<string | null>;
	set(entry: { service: string; name: string; value: string }): Promise<void>;
	delete(entry: { service: string; name: string }): Promise<boolean>;
}

/** Changing this orphans every stored credential. */
const SERVICE = "tradedeck";

/**
 * One keychain entry per account: service `tradedeck`, name = account id,
 * value = the credential as JSON. The only place in the repo that touches
 * `Bun.secrets`; it is resolved here, so a store built with a fake backend
 * never evaluates it.
 */
export function createKeychainSecretStore(
	opts: { backend?: KeychainBackend } = {},
): SecretStore {
	const backend = opts.backend ?? Bun.secrets;
	return {
		async get(accountId) {
			const value = await backend.get({ service: SERVICE, name: accountId });
			return value === null ? null : parseCredential(accountId, value);
		},
		async set(accountId, credential) {
			await backend.set({
				service: SERVICE,
				name: accountId,
				value: JSON.stringify(credential),
			});
		},
		delete(accountId) {
			return backend.delete({ service: SERVICE, name: accountId });
		},
	};
}

/** The parser's own error is dropped: its message can quote key material. */
function parseCredential(accountId: string, value: string): Credential {
	let json: unknown;
	try {
		json = JSON.parse(value);
	} catch {
		// `json` stays undefined and fails the schema below.
	}
	const parsed = CredentialSchema.safeParse(json);
	if (!parsed.success) {
		throw new Error(
			`secrets: keychain entry for account ${accountId} is not a valid credential`,
		);
	}
	return parsed.data;
}
