import type { Credential } from "@tradedeck/core";

/**
 * docs/architecture.md §9. One credential per account, keyed by `accounts.id`.
 * Only apps/server and apps/cli construct one.
 */
export interface SecretStore {
	get(accountId: string): Promise<Credential | null>;
	set(accountId: string, credential: Credential): Promise<void>;
	delete(accountId: string): Promise<boolean>;
}
