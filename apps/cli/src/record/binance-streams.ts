/**
 * Records Binance Demo user-data stream events for the adapter's
 * recorded-event tests: `bun run record:binance-streams`. Demo only — a live
 * account's data must never enter the public repo. The credential is read
 * from hidden prompts, lives in this process only, and is gone when it exits
 * (hard rule 1); no listen key, URL or signature is ever printed or written.
 *
 * The owner performs each step on demo.binance.com and presses Enter. The raw
 * events of every step are written, scrubbed, to
 * `packages/binance/__recordings__/demo/streams/user-data.json`. Alongside,
 * the adapter's own `subscribe()` prints what it emits (the Demo smoke), and
 * a probe on the legacy futures path `/ws/<listenKey>` counts its events.
 * Ctrl+C at any point writes nothing.
 */
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { intro, log, outro } from "@clack/prompts";
import { systemTimers } from "@tradedeck/adapter";
import {
	createBinanceAdapter,
	createBinanceHttp,
	ENDPOINTS,
	openFuturesUserStream,
	openSpotUserStream,
	type StreamRecording,
	scrubBody,
	type UserStreamListener,
} from "@tradedeck/binance";
import { z } from "zod";
import { readCredential } from "./prompts.ts";

const OUT_DIR = new URL(
	"../../../../packages/binance/__recordings__/demo/streams/",
	import.meta.url,
);
const OUT_FILE = "user-data.json";
const LEGACY_FUTURES_WS = "wss://demo-fstream.binance.com/ws/";
const LIVE_WITHIN_MS = 30_000;

const STEPS = [
	{
		name: "spot-limit-new",
		instruction:
			"Spot BTCUSDT: Limit Buy 0.0002 BTC about 20% below the last price.",
	},
	{ name: "spot-limit-cancel", instruction: "Spot: cancel that order." },
	{
		name: "spot-market-buy",
		instruction: "Spot BTCUSDT: Market Buy BTC for 10 USDT total.",
	},
	{
		name: "futures-leverage",
		instruction: "USDⓈ-M BTCUSDT: set leverage to 5×.",
	},
	{
		name: "futures-open-long",
		instruction: "USDⓈ-M BTCUSDT: Market Buy 0.002 BTC.",
	},
	{
		name: "futures-limit-amend-cancel",
		instruction:
			"USDⓈ-M BTCUSDT: Limit Sell 0.002 about 10% above mark, then edit its price to about 12% above, then cancel it.",
	},
	{
		name: "futures-tp-new-cancel",
		instruction:
			"Positions → TP/SL: Take Profit (Mark) about 5% above entry for the whole position; then cancel it in Open Orders → TP/SL.",
	},
	{ name: "futures-close", instruction: "Positions → Close → Market." },
	{
		name: "network-cut",
		instruction:
			"Optional: Wi-Fi off for 60 s, back on, then wait for `status live`. Press Enter right away to skip.",
	},
] as const;

type Step = StreamRecording["steps"][number];

let stepStart = Date.now();
function print(line: string): void {
	console.log(`+${Date.now() - stepStart} ${line}`);
}

function cancelled(): never {
	console.log("\nCancelled; nothing written.");
	process.exit(1);
}

const Fields = z.looseObject({
	e: z.unknown().optional(),
	x: z.unknown().optional(),
	X: z.unknown().optional(),
	o: z.unknown().optional(),
});
const Inner = z.looseObject({
	x: z.unknown().optional(),
	X: z.unknown().optional(),
});

/** `e`, plus the execution type and status when the event has them (futures: inside `o`). */
function summary(event: unknown): string {
	const f = Fields.safeParse(event).data;
	const inner = Inner.safeParse(f?.o).data;
	return [f?.e, f?.x ?? inner?.x, f?.X ?? inner?.X]
		.filter((v) => typeof v === "string")
		.join(" ");
}

const message = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

intro("tradedeck — record Binance Demo user-data streams");
log.warn("Demo only. Never enter a live API key here.");
const credential = await readCredential();
process.on("SIGINT", cancelled);
const http = createBinanceHttp({ environment: "demo", credential });

const connect: Step = {
	name: "connect",
	instruction: "Streams connect; no action.",
	events: [],
};
let current: Step = connect;
const steps: Step[] = [];
const up = { spot: false, futures: false };
let privateEvents = 0;

function raw(stream: "spot" | "futures"): UserStreamListener {
	return {
		onEvent(event) {
			if (stream === "futures") privateEvents++;
			current.events.push({ stream, event: scrubBody(event) });
			print(`[${stream}] ${summary(event)}`);
		},
		onUp() {
			up[stream] = true;
			print(`[${stream}] up`);
		},
		onDown() {
			up[stream] = false;
			print(`[${stream}] down`);
		},
		onError(err) {
			print(`[${stream}] error ${err.message}`);
		},
	};
}

const deps = {
	environment: "demo",
	http,
	now: Date.now,
	timers: systemTimers,
} as const;
const spotStream = openSpotUserStream(deps, raw("spot"));
const futuresStream = openFuturesUserStream(deps, raw("futures"));

// Probe: POST returns the account's one active key, shared with the stream
// above. Counts events with a string `e` on the legacy path; nothing else.
let probeEvents = 0;
let probe: WebSocket | null = null;
try {
	const { listenKey } = await http.request(
		ENDPOINTS.listenKey,
		z.object({ listenKey: z.string().min(1) }),
	);
	probe = new WebSocket(`${LEGACY_FUTURES_WS}${listenKey}`);
	probe.onmessage = (frame) => {
		try {
			const e = Fields.safeParse(JSON.parse(String(frame.data))).data?.e;
			if (typeof e === "string") probeEvents++;
		} catch {
			// Not JSON: not an event.
		}
	};
	probe.onerror = () => print("[probe /ws] error");
} catch (err) {
	print(`[probe /ws] error ${message(err)}`);
}

let status = "";
const unsubscribe = createBinanceAdapter({
	accountId: "demo",
	environment: "demo",
	credential,
}).subscribe({
	onSnapshot: (s) =>
		print(
			`snapshot ${s.balances.length} balances, ${s.positions.length} positions, ${s.openOrders.length} orders`,
		),
	onBalance: (b) => print(`balance ${b.scope} ${b.asset} ${b.total}`),
	onPosition: (p) =>
		print(
			`position ${p.instrumentId} ${p.positionSide} ${p.size} liq ${p.liquidationPrice ?? "—"}`,
		),
	onOrder: (o) =>
		print(
			`order ${o.instrumentId} ${o.type} ${o.status} ${o.filledQty}/${o.qty}`,
		),
	onFill: (f) =>
		print(
			`fill ${f.instrumentId} ${f.side} ${f.qty}@${f.price} fee ${f.fee} ${f.feeAsset}`,
		),
	onStatus: (s) => {
		status = s;
		print(`status ${s}`);
	},
	onError: (err) => print(`error ${err.message}`),
});

const deadline = Date.now() + LIVE_WITHIN_MS;
while (!(up.spot && up.futures && status === "live")) {
	if (Date.now() > deadline) {
		log.error(
			`Not live within ${LIVE_WITHIN_MS / 1000} s (spot ${up.spot ? "up" : "down"}, futures ${up.futures ? "up" : "down"}, adapter ${status}); nothing written.`,
		);
		process.exit(1);
	}
	await Bun.sleep(100);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on("SIGINT", cancelled);
for (const [i, step] of STEPS.entries()) {
	current = { ...step, events: [] };
	steps.push(current);
	log.step(`${i + 1}/${STEPS.length} ${step.name}: ${step.instruction}`);
	stepStart = Date.now();
	await rl.question("Press Enter when done. ");
}
rl.close();

try {
	await http.request(ENDPOINTS.listenKeyKeepalive, z.object({}));
	print("keepalive ok");
} catch (err) {
	print(`keepalive ${message(err)}`);
}
print(`futures events: /private ${privateEvents}, /ws ${probeEvents}`);
unsubscribe();
spotStream.close();
futuresStream.close();
probe?.close();

const recording: StreamRecording = {
	note: `Binance Demo ${new Date().toISOString().slice(0, 10)} via bun run record:binance-streams; scrubbed`,
	steps: connect.events.length > 0 ? [connect, ...steps] : steps,
};
await mkdir(OUT_DIR, { recursive: true });
await Bun.write(
	new URL(OUT_FILE, OUT_DIR),
	`${JSON.stringify(recording, null, "\t")}\n`,
);
log.success(
	`Wrote packages/binance/__recordings__/demo/streams/${OUT_FILE} (${steps.reduce((n, s) => n + s.events.length, connect.events.length)} events).`,
);
outro("Now delete this API key on demo.binance.com.");
process.exit(0);
