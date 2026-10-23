/**
 * Records Binance Demo responses for the adapter's recorded-response tests:
 * `bun run record:binance`. Demo only — a live account's data must never
 * enter the public repo. The credential is read from hidden prompts, lives in
 * this process only, and is gone when it exits (hard rule 1).
 */
import { generateKeyPairSync } from "node:crypto";
import {
	cancel,
	confirm,
	intro,
	isCancel,
	log,
	note,
	outro,
	password,
	select,
} from "@clack/prompts";
import type { Credential } from "@tradedeck/core";
import { recordScenario } from "./recorder.ts";

const OUT_DIR = new URL(
	"../../../../packages/binance/__recordings__/demo/",
	import.meta.url,
);

function answer<T>(value: T): Exclude<T, symbol> {
	if (isCancel(value)) {
		cancel("Cancelled; nothing written.");
		process.exit(1);
	}
	return value as Exclude<T, symbol>;
}

async function readCredential(): Promise<Credential> {
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
		note(
			publicKey.export({ type: "spki", format: "pem" }).toString(),
			"Paste into demo.binance.com → API Management → Self-generated; enable Reading only",
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

async function record(credential: Credential, scenario: string) {
	const lines = await recordScenario({
		credential,
		scenario,
		outDir: OUT_DIR,
		onWarn: (message) => log.warn(message),
	});
	note(
		lines.join("\n"),
		`Recorded "${scenario}" → packages/binance/__recordings__/demo/${scenario}/`,
	);
}

intro("tradedeck — record Binance Demo responses");
log.warn("Demo only. Never enter a live API key here.");
const credential = await readCredential();
await record(credential, "oneway");
const hedge = answer(
	await confirm({
		message:
			"Record the hedge scenario? First close every futures position and order, switch Demo futures to Hedge Mode, open a BTCUSDT LONG and a SHORT, and put a TP on one.",
		initialValue: true,
	}),
);
if (hedge) await record(credential, "hedge");
outro("Done. Now delete this API key on demo.binance.com.");
process.exit(0);
