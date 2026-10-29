import { generateKeyPairSync } from "node:crypto";
import { cancel, isCancel, log, password, select } from "@clack/prompts";
import type { Credential } from "@tradedeck/core";

export function answer<T>(value: T): Exclude<T, symbol> {
	if (isCancel(value)) {
		cancel("Cancelled; nothing written.");
		process.exit(1);
	}
	return value as Exclude<T, symbol>;
}

export async function readCredential(): Promise<Credential> {
	const kind = answer(
		await select({
			message: "Demo API key type",
			options: [
				{ value: "ed25519", label: "Ed25519 (self-generated, recommended)" },
				{ value: "hmac", label: "HMAC (system-generated)" },
			],
		}),
	);
	if (kind === "ed25519") {
		const { publicKey, privateKey } = generateKeyPairSync("ed25519");
		log.step(
			"Paste this public key into demo.binance.com → API Management → Self-generated; enable Reading only:",
		);
		process.stdout.write(
			`\n${publicKey.export({ type: "spki", format: "pem" }).toString()}\n`,
		);
		const apiKey = answer(await password({ message: "Demo API key" }));
		return {
			kind,
			apiKey,
			privateKeyPem: privateKey
				.export({ type: "pkcs8", format: "pem" })
				.toString(),
		};
	}
	const apiKey = answer(await password({ message: "Demo API key" }));
	const secret = answer(await password({ message: "Demo secret key" }));
	return { kind: "hmac", apiKey, secret };
}
