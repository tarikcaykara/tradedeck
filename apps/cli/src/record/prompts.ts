import { cancel, isCancel, log, password, select } from "@clack/prompts";
import type { Credential } from "@tradedeck/core";
import { generateEd25519KeyPair } from "../ed25519.ts";

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
		const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
		log.step(
			"Paste this public key into demo.binance.com → API Management → Self-generated; enable Reading only:",
		);
		process.stdout.write(`\n${publicKeyPem}\n`);
		const apiKey = answer(await password({ message: "Demo API key" }));
		return { kind, apiKey, privateKeyPem };
	}
	const apiKey = answer(await password({ message: "Demo API key" }));
	const secret = answer(await password({ message: "Demo secret key" }));
	return { kind: "hmac", apiKey, secret };
}
