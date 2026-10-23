import {
	createHmac,
	createPrivateKey,
	type KeyObject,
	sign,
} from "node:crypto";
import type { Credential } from "@tradedeck/core";

/**
 * Signs a request payload with one credential. The secret lives only in the
 * closure: no property of a signer carries it, so logging or serialising a
 * signer cannot leak it (hard rule 1).
 */
export interface Signer {
	readonly apiKey: string;
	/** HMAC-SHA256 → lowercase hex; Ed25519 → base64 (not URL-encoded). */
	sign(payload: string): string;
}

const NOT_ED25519 = "credential: privateKeyPem is not an Ed25519 private key";

export function createSigner(credential: Credential): Signer {
	switch (credential.kind) {
		case "hmac": {
			const { secret } = credential;
			return {
				apiKey: credential.apiKey,
				sign: (payload) =>
					createHmac("sha256", secret).update(payload, "utf8").digest("hex"),
			};
		}
		case "ed25519": {
			const key = ed25519PrivateKey(credential.privateKeyPem);
			return {
				apiKey: credential.apiKey,
				sign: (payload) =>
					sign(null, Buffer.from(payload, "utf8"), key).toString("base64"),
			};
		}
	}
}

/** Parses the PEM once; the parser's own error is dropped so no key material is echoed. */
function ed25519PrivateKey(pem: string): KeyObject {
	let key: KeyObject;
	try {
		key = createPrivateKey(pem);
	} catch {
		throw new Error(NOT_ED25519);
	}
	if (key.asymmetricKeyType !== "ed25519") throw new Error(NOT_ED25519);
	return key;
}
