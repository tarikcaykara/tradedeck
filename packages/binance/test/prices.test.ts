import { describe, expect, test } from "bun:test";
import type { InstrumentId, PriceUpdate } from "@tradedeck/core";
import { z } from "zod";
import { createPriceFeed } from "../src/prices.ts";
import { manualClock } from "./support/clock.ts";
import { type FakeSocket, fakeWebSockets } from "./support/fake-ws.ts";

const SPOT = "wss://demo-stream.binance.com/ws";
const FUTURES = "wss://demo-fstream.binance.com/market/ws";
const BTC_SPOT: InstrumentId = "binance:spot:BTCUSDT";
const ETH_SPOT: InstrumentId = "binance:spot:ETHUSDT";
const SOL_SPOT: InstrumentId = "binance:spot:SOLUSDT";
const BTC_PERP: InstrumentId = "binance:linear:BTCUSDT";

// Shapes as Demo sent them (probe 2026-11-03).
const miniTicker = (s: string, c: string, E: number) => ({
	e: "24hrMiniTicker",
	E,
	s,
	c,
	o: "77892.00000000",
	h: "78156.02000000",
	l: "76388.88000000",
	v: "14808.58565000",
	q: "1142003299.45874620",
});
const markPrice = (s: string, p: string, E: number) => ({
	e: "markPriceUpdate",
	E,
	s,
	p,
	ap: p,
	P: "77274.08776957",
	i: "77263.38717391",
	r: "0.00008137",
	T: 1793721600000,
	st: 1,
});

const Control = z.object({
	method: z.enum(["SUBSCRIBE", "UNSUBSCRIBE"]),
	params: z.array(z.string()),
	id: z.number().int().nonnegative(),
});

/** The control messages a socket sent, without their ids. */
function controls(ws: FakeSocket): { method: string; params: string[] }[] {
	return ws.frames().map((f) => {
		const { method, params } = Control.parse(f);
		return { method, params };
	});
}

function setup() {
	const clock = manualClock();
	const sockets = fakeWebSockets();
	const feed = createPriceFeed({
		environment: "demo",
		now: clock.now,
		timers: clock.timers,
		WebSocket: sockets.WebSocket,
	});
	const prices: PriceUpdate[] = [];
	const onPrice = (p: PriceUpdate) => {
		prices.push(p);
	};
	return { clock, sockets, feed, prices, onPrice };
}

describe("subscribePrices", () => {
	test("spot last and futures mark prices map to onPrice with their kind", async () => {
		const t = setup();
		t.feed.subscribe([BTC_SPOT, BTC_PERP], t.onPrice);
		await t.clock.advance(0);
		const spot = t.sockets.latest(SPOT);
		const futures = t.sockets.latest(FUTURES);
		spot.open();
		futures.open();
		expect(controls(spot)).toEqual([
			{ method: "SUBSCRIBE", params: ["btcusdt@miniTicker"] },
		]);
		expect(controls(futures)).toEqual([
			{ method: "SUBSCRIBE", params: ["btcusdt@markPrice@1s"] },
		]);
		spot.message({ result: null, id: 1 });
		spot.message(miniTicker("BTCUSDT", "77264.03000000", 1793715809017));
		futures.message(markPrice("BTCUSDT", "77214.43784420", 1793715817000));
		expect(t.prices).toEqual([
			{
				instrumentId: BTC_SPOT,
				price: "77264.03000000",
				kind: "last",
				ts: 1793715809017,
			},
			{
				instrumentId: BTC_PERP,
				price: "77214.43784420",
				kind: "mark",
				ts: 1793715817000,
			},
		]);
	});

	test("a reconnect resubscribes the current set", async () => {
		const t = setup();
		const unsubscribeEth = t.feed.subscribe([ETH_SPOT], t.onPrice);
		t.feed.subscribe([BTC_SPOT], t.onPrice);
		await t.clock.advance(0);
		t.sockets.latest(SPOT).open();
		unsubscribeEth();
		t.feed.subscribe([SOL_SPOT], t.onPrice);
		t.sockets.latest(SPOT).drop();
		await t.clock.advance(1000);
		expect(t.sockets.count(SPOT)).toBe(2);
		t.sockets.latest(SPOT).open();
		expect(controls(t.sockets.latest(SPOT))).toEqual([
			{
				method: "SUBSCRIBE",
				params: ["btcusdt@miniTicker", "solusdt@miniTicker"],
			},
		]);
	});

	test("changes after the open are batched into one message per second at most", async () => {
		const t = setup();
		const unsubscribeBtc = t.feed.subscribe([BTC_SPOT], t.onPrice);
		await t.clock.advance(0);
		const ws = t.sockets.latest(SPOT);
		ws.open();
		t.feed.subscribe([ETH_SPOT], t.onPrice);
		t.feed.subscribe([SOL_SPOT], t.onPrice);
		unsubscribeBtc();
		await t.clock.advance(999);
		expect(controls(ws)).toHaveLength(1);
		await t.clock.advance(1);
		expect(controls(ws)).toEqual([
			{ method: "SUBSCRIBE", params: ["btcusdt@miniTicker"] },
			{
				method: "SUBSCRIBE",
				params: ["ethusdt@miniTicker", "solusdt@miniTicker"],
			},
			{ method: "UNSUBSCRIBE", params: ["btcusdt@miniTicker"] },
		]);
		expect(new Set(ws.frames().map((f) => Control.parse(f).id)).size).toBe(3);
	});

	test("a subscribe and unsubscribe within one batch send nothing", async () => {
		const t = setup();
		t.feed.subscribe([BTC_SPOT], t.onPrice);
		await t.clock.advance(0);
		const ws = t.sockets.latest(SPOT);
		ws.open();
		t.feed.subscribe([ETH_SPOT], t.onPrice)();
		await t.clock.advance(1000);
		expect(controls(ws)).toHaveLength(1);
	});

	test("two subscriptions share one stream, each gets every price, the stream stays until both leave", async () => {
		const t = setup();
		const other: PriceUpdate[] = [];
		const first = t.feed.subscribe([BTC_SPOT], t.onPrice);
		t.feed.subscribe([BTC_SPOT], (p) => other.push(p));
		await t.clock.advance(0);
		const ws = t.sockets.latest(SPOT);
		ws.open();
		first();
		await t.clock.advance(1000);
		ws.message(miniTicker("BTCUSDT", "1.5", 1));
		expect(controls(ws)).toEqual([
			{ method: "SUBSCRIBE", params: ["btcusdt@miniTicker"] },
		]);
		expect(t.prices).toEqual([]);
		expect(other.map((p) => p.price)).toEqual(["1.5"]);
	});

	test("the last unsubscribe closes the socket and clears every timer", async () => {
		const t = setup();
		const unsubscribe = t.feed.subscribe([BTC_SPOT, BTC_PERP], t.onPrice);
		await t.clock.advance(0);
		t.sockets.latest(SPOT).open();
		t.sockets.latest(FUTURES).open();
		unsubscribe();
		unsubscribe();
		expect(t.sockets.latest(SPOT).readyState).toBe(3);
		expect(t.sockets.latest(FUTURES).readyState).toBe(3);
		expect(t.clock.pending()).toBe(0);
		t.sockets.latest(SPOT).message(miniTicker("BTCUSDT", "1", 1));
		expect(t.prices).toEqual([]);
	});

	test("a symbol with non-ASCII characters keeps them in the stream name and maps back", async () => {
		const t = setup();
		const id: InstrumentId = "binance:spot:币安人生USDT";
		t.feed.subscribe([id], t.onPrice);
		await t.clock.advance(0);
		const ws = t.sockets.latest(SPOT);
		ws.open();
		ws.message(miniTicker("币安人生USDT", "0.3", 7));
		expect(controls(ws)).toEqual([
			{ method: "SUBSCRIBE", params: ["币安人生usdt@miniTicker"] },
		]);
		expect(t.prices).toEqual([
			{ instrumentId: id, price: "0.3", kind: "last", ts: 7 },
		]);
	});

	test("a price frame that does not decode is dropped", async () => {
		const t = setup();
		t.feed.subscribe([BTC_SPOT], t.onPrice);
		await t.clock.advance(0);
		const ws = t.sockets.latest(SPOT);
		ws.open();
		ws.message(miniTicker("BTCUSDT", "not a price", 1));
		ws.message(miniTicker("BTCUSDT", "2", 2));
		expect(t.prices.map((p) => p.price)).toEqual(["2"]);
	});

	test("a late frame from a closed socket never acts on the next connection", async () => {
		const t = setup();
		const unsubscribe = t.feed.subscribe([BTC_SPOT], t.onPrice);
		await t.clock.advance(0);
		const first = t.sockets.latest(SPOT);
		first.open();
		unsubscribe();
		t.feed.subscribe([BTC_SPOT], t.onPrice);
		await t.clock.advance(0);
		expect(t.sockets.count(SPOT)).toBe(2);
		t.sockets.latest(SPOT).open();
		first.message("not json");
		first.message(miniTicker("BTCUSDT", "9", 9));
		await t.clock.advance(1000);
		expect(t.sockets.count(SPOT)).toBe(2);
		expect(t.prices).toEqual([]);
	});

	test.each([
		["serverShutdown", { e: "serverShutdown", E: 1 }],
		["a frame that is not JSON", "not json"],
	])("%s reconnects and resubscribes", async (_, frame) => {
		const t = setup();
		t.feed.subscribe([BTC_SPOT], t.onPrice);
		await t.clock.advance(0);
		t.sockets.latest(SPOT).open();
		t.sockets.latest(SPOT).message(frame);
		await t.clock.advance(1000);
		expect(t.sockets.count(SPOT)).toBe(2);
		t.sockets.latest(SPOT).open();
		expect(controls(t.sockets.latest(SPOT))).toEqual([
			{ method: "SUBSCRIBE", params: ["btcusdt@miniTicker"] },
		]);
	});

	test.each<InstrumentId>(["binance:inverse:BTCUSD_PERP"])(
		"%s has no price stream: throws and opens nothing",
		(id) => {
			const t = setup();
			expect(() => t.feed.subscribe([BTC_SPOT, id], t.onPrice)).toThrow(
				`binance: no price stream for ${id}`,
			);
			expect(t.sockets.all).toHaveLength(0);
		},
	);
});
