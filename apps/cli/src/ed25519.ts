import { generateKeyPairSync } from "node:crypto";

export interface Ed25519KeyPair {
	publicKeyPem: string;
	privateKeyPem: string;
}

/** In memory only; the private key never touches disk (architecture §9). */
export function generateEd25519KeyPair(): Ed25519KeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKeyPem: privateKey
			.export({ type: "pkcs8", format: "pem" })
			.toString(),
	};
}
