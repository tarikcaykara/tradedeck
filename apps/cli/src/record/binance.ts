/**
 * Records Binance Demo responses for the adapter's recorded-response tests:
 * `bun run record:binance`. Demo only — a live account's data must never
 * enter the public repo. The credential is read from hidden prompts, lives in
 * this process only, and is gone when it exits (hard rule 1).
 */
import { confirm, intro, log, note, outro } from "@clack/prompts";
import type { Credential } from "@tradedeck/core";
import { answer, readCredential } from "./prompts.ts";
import { recordScenario } from "./recorder.ts";

const OUT_DIR = new URL(
	"../../../../packages/binance/__recordings__/demo/",
	import.meta.url,
);

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
