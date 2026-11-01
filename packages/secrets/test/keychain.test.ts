import { describe, expect, test } from "bun:test";
import type { Credential } from "@tradedeck/core";
import {
	createKeychainSecretStore,
	type KeychainBackend,
} from "../src/keychain.ts";

// Dummy values only (hard rule 1). The PEM is the RFC 8032 §7.1 TEST 2 key
// from packages/adapter/test/signer.test.ts; the store never parses it.
const HMAC: Credential = {
	kind: "hmac",
	apiKey: "k",
	secret: "S3CRET-FRAGMENT",
};
const ED25519: Credential = {
	kind: "ed25519",
	apiKey: "k",
	privateKeyPem: [
		"-----BEGIN PRIVATE KEY-----",
		"MC4CAQAwBQYDK2VwBCIEIEzNCJso/5banbbDRuwRTg9bijGfNaumJNqM9u1PuKb7",
		"-----END PRIVATE KEY-----",
	].join("\n"),
};

/** In-memory stand-in with `Bun.secrets` semantics, keyed `${service}/${name}`. */
function fakeBackend() {
	const entries = new Map<string, string>();
	const backend: KeychainBackend = {
		get: async ({ service, name }) => entries.get(`${service}/${name}`) ?? null,
		set: async ({ service, name, value }) => {
			entries.set(`${service}/${name}`, value);
		},
		delete: async ({ service, name }) => entries.delete(`${service}/${name}`),
	};
	return { backend, entries };
}

describe("createKeychainSecretStore", () => {
	test.each([
		["hmac", HMAC],
		["ed25519", ED25519],
	] as const)("round-trips an %s credential", async (_kind, credential) => {
		const store = createKeychainSecretStore({ backend: fakeBackend().backend });
		await store.set("acc-1", credential);
		expect(await store.get("acc-1")).toEqual(credential);
	});

	test("stores the credential as JSON under service tradedeck, name = account id", async () => {
		const { backend, entries } = fakeBackend();
		await createKeychainSecretStore({ backend }).set("acc-1", HMAC);
		expect([...entries.keys()]).toEqual(["tradedeck/acc-1"]);
		expect(JSON.parse(entries.get("tradedeck/acc-1") ?? "")).toEqual(HMAC);
	});

	test("set replaces an account's entry and leaves other accounts alone", async () => {
		const store = createKeychainSecretStore({ backend: fakeBackend().backend });
		await store.set("acc-1", HMAC);
		await store.set("acc-2", ED25519);
		await store.set("acc-1", { ...HMAC, secret: "other" });
		expect(await store.get("acc-1")).toEqual({ ...HMAC, secret: "other" });
		expect(await store.get("acc-2")).toEqual(ED25519);
	});

	test("get of a missing account resolves null", async () => {
		const store = createKeychainSecretStore({ backend: fakeBackend().backend });
		expect(await store.get("acc-1")).toBeNull();
	});

	test("delete reports whether an entry existed", async () => {
		const store = createKeychainSecretStore({ backend: fakeBackend().backend });
		await store.set("acc-1", HMAC);
		expect(await store.delete("acc-1")).toBe(true);
		expect(await store.get("acc-1")).toBeNull();
		expect(await store.delete("acc-1")).toBe(false);
	});

	test.each([
		["plain text", "S3CRET-FRAGMENT"],
		[
			"truncated JSON",
			'{"kind":"hmac","apiKey":"k","secret":"S3CRET-FRAGMENT"',
		],
		["missing field", JSON.stringify({ kind: "hmac", apiKey: "k" })],
		[
			"unknown kind",
			JSON.stringify({ kind: "rsa", apiKey: "k", secret: "S3CRET-FRAGMENT" }),
		],
		["extra field", JSON.stringify({ ...HMAC, privateKeyPem: "x" })],
	])("a corrupt entry (%s) throws a fixed message", async (_case, value) => {
		const { backend, entries } = fakeBackend();
		entries.set("tradedeck/acc-1", value);
		// An Error argument makes toThrow compare the whole message, so no
		// fragment of the stored value can ride along.
		await expect(
			createKeychainSecretStore({ backend }).get("acc-1"),
		).rejects.toThrow(
			new Error(
				"secrets: keychain entry for account acc-1 is not a valid credential",
			),
		);
	});
});
