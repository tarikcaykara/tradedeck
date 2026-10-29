import { afterEach, describe, expect, test } from "bun:test";
import { VenueError, type WebSocketCtor } from "@tradedeck/adapter";
import type { AccountStatus, Order, Position } from "@tradedeck/core";
import type { Server, ServerWebSocket } from "bun";
import { createBinanceAdapter } from "../src/adapter.ts";
import {
	type AccountHarness,
	type Call,
	startAccount,
} from "./support/account.ts";
import {
	accountUpdate,
	algoUpdate,
	executionReport,
	leverageUpdate,
	orderTradeUpdate,
	outboundAccountPosition,
} from "./support/events.ts";
import { loadScenario, replay } from "./support/replay.ts";
import { until } from "./support/wait.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let harness: AccountHarness | undefined;
afterEach(() => {
	harness?.unsubscribe();
	harness = undefined;
});

/** A subscribed harness, unsubscribed after the test. */
async function start(): Promise<AccountHarness> {
	harness = await startAccount();
	return harness;
}

/** A live harness with an empty call log. */
async function live(): Promise<AccountHarness> {
	const h = await start();
	await h.goLive();
	h.take();
	return h;
}

const kinds = (calls: Call[]) => calls.map((c) => c[0]);
const orders = (calls: Call[]) =>
	calls.flatMap((c) => (c[0] === "order" ? [c[1]] : []));
const errorOf = (calls: Call[]): Error => {
	const call = calls.find((c) => c[0] === "error");
	if (call === undefined) throw new Error("no error call");
	return call[1] as Error;
};

/** The recorded one-way BTCUSDT position, as the snapshot maps it. */
const BTC_POSITION: Position = {
	accountId: "acc-1",
	instrumentId: "binance:linear:BTCUSDT",
	side: "long",
	positionSide: "both",
	size: "0.0024",
	entryPrice: "80345.2",
	markPrice: "80343.30000000",
	liquidationPrice: null,
	unrealizedPnl: "-0.00456000",
	leverage: 7,
	marginMode: "cross",
	updatedAt: 1792865622583,
};

describe("subscribe: lifecycle", () => {
	test("connecting, then the snapshot, then live", async () => {
		const h = await start();
		expect(h.calls).toEqual([["status", "connecting"]]);
		await h.goLive();
		expect(h.calls).toEqual([
			["status", "connecting"],
			["snapshot", await h.fetchSnapshot()],
			["status", "live"],
		]);
	});

	test("events during the snapshot are applied after it, in E order, before live", async () => {
		const h = await start();
		const release = h.hold("/api/v3/account");
		await h.openStreams();
		await h.answerSubscribe();
		await until(() =>
			h.requests.some((r) => r.startsWith("GET /api/v3/account")),
		);
		h.pushSpot(executionReport({ E: 20, i: 2, c: "second" }));
		h.pushSpot(executionReport({ E: 10, i: 1, c: "first" }));
		release();
		await until(() => h.statuses().at(-1) === "live");
		expect(kinds(h.calls)).toEqual([
			"status",
			"snapshot",
			"order",
			"order",
			"status",
		]);
		expect(orders(h.calls).map((o) => o.clientOrderId)).toEqual([
			"first",
			"second",
		]);
	});

	test("a futures drop resyncs: resyncing, a new listen key, a new snapshot, live", async () => {
		const h = await live();
		h.futures().drop();
		expect(h.take()).toEqual([["status", "resyncing"]]);
		await h.clock.advance(1000);
		await h.openStreams();
		await until(() => h.statuses().at(-1) === "live");
		expect(kinds(h.take())).toEqual(["snapshot", "status"]);
		expect(
			h.requests.filter((r) => r === "POST /fapi/v1/listenKey"),
		).toHaveLength(2);
		expect(h.futures().url).toEndWith("lk-2");
	});

	test("three failed reconnects are down; the next success is live", async () => {
		const h = await live();
		h.route = (req) =>
			req.method === "POST" && req.path === "/fapi/v1/listenKey"
				? new Response("unavailable", { status: 503 })
				: undefined;
		h.futures().drop();
		// Backoff caps 1 s, 2 s, 4 s: each advance covers exactly one attempt.
		await h.clock.advance(1000);
		await h.clock.advance(2000);
		expect(h.statuses()).toEqual(["resyncing"]);
		await h.clock.advance(4000);
		const failed = h.take();
		expect(kinds(failed)).toEqual([
			"status",
			"error",
			"error",
			"error",
			"status",
		]);
		expect(h.statuses()).toEqual([]);
		expect(failed.at(-1)).toEqual(["status", "down"]);
		h.route = null;
		await h.clock.advance(8000);
		await h.openStreams();
		await until(() => h.statuses().at(-1) === "live");
		expect(kinds(h.take())).toEqual(["snapshot", "status"]);
	});

	test("a failed first snapshot is retried after 1 s", async () => {
		const h = await start();
		let refused = 0;
		h.route = (req) =>
			req.path === "/fapi/v3/positionRisk" && refused++ === 0
				? new Response("oops", { status: 500 })
				: undefined;
		await h.openStreams();
		await h.answerSubscribe();
		await until(() => h.calls.length === 2);
		expect(kinds(h.calls)).toEqual(["status", "error"]);
		expect(errorOf(h.calls)).toBeInstanceOf(VenueError);
		await h.clock.advance(999);
		expect(h.calls).toHaveLength(2);
		await h.clock.advance(1);
		await until(() => h.statuses().at(-1) === "live");
		expect(kinds(h.calls)).toEqual(["status", "error", "snapshot", "status"]);
	});

	test("unsubscribe stops every call and clears every timer", async () => {
		const h = await live();
		h.unsubscribe();
		expect(h.clock.pending()).toBe(0);
		h.pushSpot(executionReport());
		h.pushFutures(orderTradeUpdate());
		h.spot().drop();
		h.futures().drop();
		await h.clock.advance(HOUR);
		expect(h.calls).toEqual([]);
		expect(h.clock.pending()).toBe(0);
	});
});

describe("subscribe: timers", () => {
	test("the 30 min keepalive keeps the account live", async () => {
		const h = await live();
		await h.clock.advance(30 * MINUTE);
		expect(
			h.requests.filter((r) => r === "PUT /fapi/v1/listenKey"),
		).toHaveLength(1);
		expect(h.calls).toEqual([]);
	});

	test("the 23 h rotation replaces both streams through one resync", async () => {
		const h = await live();
		await h.clock.advance(23 * HOUR);
		expect(h.take()).toEqual([["status", "resyncing"]]);
		await h.clock.advance(1000);
		await h.openStreams();
		await h.answerSubscribe();
		await until(() => h.statuses().at(-1) === "live");
		expect(kinds(h.take())).toEqual(["snapshot", "status"]);
		expect(h.sockets.all).toHaveLength(4);
	});
});

describe("subscribe: spot executionReport", () => {
	const NEW_ORDER: Order = {
		accountId: "acc-1",
		instrumentId: "binance:spot:BTCUSDT",
		venueOrderId: "1001",
		clientOrderId: "web_spot_1",
		side: "buy",
		type: "limit",
		status: "new",
		qty: "0.00020000",
		filledQty: "0.00000000",
		price: "60000.00000000",
		triggerPrice: null,
		reduceOnly: false,
		timeInForce: "gtc",
		positionSide: "both",
		createdAt: 1_800_000_000_100,
		updatedAt: 1_800_000_000_100,
	};

	test("NEW is the order", async () => {
		const h = await live();
		h.pushSpot(executionReport());
		expect(h.calls).toEqual([["order", NEW_ORDER]]);
	});

	test("LIMIT_MAKER is a post-only limit order", async () => {
		const h = await live();
		h.pushSpot(executionReport({ o: "LIMIT_MAKER" }));
		expect(orders(h.calls)[0]).toMatchObject({
			type: "limit",
			timeInForce: "post_only",
		});
	});

	test("a cancel keeps the order's own client id from C", async () => {
		const h = await live();
		h.pushSpot(
			executionReport({
				c: "cancel_request_1",
				C: "web_spot_1",
				x: "CANCELED",
				X: "CANCELED",
				T: 1_800_000_000_150,
			}),
		);
		expect(h.calls).toEqual([
			[
				"order",
				{
					...NEW_ORDER,
					status: "canceled",
					updatedAt: 1_800_000_000_150,
				},
			],
		]);
	});

	test("TRADE is the updated order and a fill", async () => {
		const h = await live();
		h.pushSpot(
			executionReport({
				x: "TRADE",
				X: "PARTIALLY_FILLED",
				l: "0.00010000",
				z: "0.00010000",
				L: "59990.00000000",
				n: "0.00000010",
				N: "BTC",
				t: 77,
				T: 1_800_000_000_160,
			}),
		);
		expect(h.calls).toEqual([
			[
				"order",
				{
					...NEW_ORDER,
					status: "partially_filled",
					filledQty: "0.00010000",
					updatedAt: 1_800_000_000_160,
				},
			],
			[
				"fill",
				{
					accountId: "acc-1",
					instrumentId: "binance:spot:BTCUSDT",
					venueTradeId: "77",
					venueOrderId: "1001",
					side: "buy",
					qty: "0.00010000",
					price: "59990.00000000",
					fee: "0.00000010",
					feeAsset: "BTC",
					realizedPnl: null,
					ts: 1_800_000_000_160,
				},
			],
		]);
	});

	test("a fill without commission has no fee asset", async () => {
		const h = await live();
		h.pushSpot(
			executionReport({ x: "TRADE", X: "FILLED", l: "0.0002", L: "1", t: 5 }),
		);
		expect(h.calls[1]).toMatchObject(["fill", { fee: "0", feeAsset: "" }]);
	});

	test("a fee without its asset is a decode error and a resync", async () => {
		const h = await live();
		h.pushSpot(
			executionReport({ x: "TRADE", X: "FILLED", n: "0.1", N: null, t: 5 }),
		);
		const calls = h.take();
		expect(kinds(calls)).toEqual(["error", "status"]);
		expect(errorOf(calls).message).toContain("commission asset missing");
		expect(errorOf(calls)).toMatchObject({
			kind: "decode",
			method: "WS",
			path: "spot executionReport",
		});
		expect(h.statuses()).toEqual([]);
		expect(calls[1]).toEqual(["status", "resyncing"]);
		await until(() => h.statuses().at(-1) === "live");
		expect(h.sockets.all).toHaveLength(2);
	});
});

describe("subscribe: spot outboundAccountPosition", () => {
	test("every row is an absolute spot balance", async () => {
		const h = await live();
		h.pushSpot(
			outboundAccountPosition([
				{ a: "BTC", f: "0.00031988", l: "0.00000000" },
				{ a: "USDT", f: "4975.36734080", l: "5.00000000" },
			]),
		);
		expect(h.calls).toEqual([
			[
				"balance",
				{
					accountId: "acc-1",
					scope: "spot",
					asset: "BTC",
					free: "0.00031988",
					locked: "0.00000000",
					total: "0.00031988",
				},
			],
			[
				"balance",
				{
					accountId: "acc-1",
					scope: "spot",
					asset: "USDT",
					free: "4975.36734080",
					locked: "5.00000000",
					total: "4980.3673408",
				},
			],
		]);
	});
});

describe("subscribe: futures ORDER_TRADE_UPDATE", () => {
	const NEW_ORDER: Order = {
		accountId: "acc-1",
		instrumentId: "binance:linear:BTCUSDT",
		venueOrderId: "5001",
		clientOrderId: "web_fut_1",
		side: "buy",
		type: "limit",
		status: "new",
		qty: "0.002",
		filledQty: "0",
		price: "70000",
		triggerPrice: null,
		reduceOnly: false,
		timeInForce: "gtc",
		positionSide: "both",
		createdAt: 1_800_000_000_300,
		updatedAt: 1_800_000_000_300,
	};

	test("NEW, AMENDMENT, TRADE and CANCELED keep the creation time of NEW", async () => {
		const h = await live();
		h.pushFutures(orderTradeUpdate({}, 1_800_000_000_301));
		h.pushFutures(
			orderTradeUpdate(
				{ x: "AMENDMENT", p: "69000", T: 1_800_000_000_400 },
				1_800_000_000_401,
			),
		);
		h.pushFutures(
			orderTradeUpdate(
				{
					x: "TRADE",
					X: "PARTIALLY_FILLED",
					p: "69000",
					l: "0.001",
					z: "0.001",
					L: "69000",
					N: "USDT",
					n: "0.0276",
					t: 9001,
					rp: "1.5",
					T: 1_800_000_000_500,
				},
				1_800_000_000_501,
			),
		);
		h.pushFutures(
			orderTradeUpdate(
				{
					x: "CANCELED",
					X: "CANCELED",
					p: "69000",
					z: "0.001",
					T: 1_800_000_000_600,
				},
				1_800_000_000_601,
			),
		);
		expect(h.calls).toEqual([
			["order", NEW_ORDER],
			["order", { ...NEW_ORDER, price: "69000", updatedAt: 1_800_000_000_400 }],
			[
				"order",
				{
					...NEW_ORDER,
					status: "partially_filled",
					price: "69000",
					filledQty: "0.001",
					updatedAt: 1_800_000_000_500,
				},
			],
			[
				"fill",
				{
					accountId: "acc-1",
					instrumentId: "binance:linear:BTCUSDT",
					venueTradeId: "9001",
					venueOrderId: "5001",
					side: "buy",
					qty: "0.001",
					price: "69000",
					fee: "0.0276",
					feeAsset: "USDT",
					realizedPnl: "1.5",
					ts: 1_800_000_000_500,
				},
			],
			[
				"order",
				{
					...NEW_ORDER,
					status: "canceled",
					price: "69000",
					filledQty: "0.001",
					updatedAt: 1_800_000_000_600,
				},
			],
		]);
	});

	test("an order from the snapshot keeps the snapshot's creation time", async () => {
		const h = await live();
		h.pushFutures(
			orderTradeUpdate({
				c: "web_st_tZatSH4J3euuiWF",
				i: 28650413040,
				S: "SELL",
				o: "TAKE_PROFIT_MARKET",
				f: "GTE_GTC",
				q: "0.0024",
				p: "0",
				sp: "90000",
				R: true,
				x: "CANCELED",
				X: "CANCELED",
			}),
		);
		expect(orders(h.calls)[0]).toMatchObject({
			venueOrderId: "28650413040",
			createdAt: 1792865622588,
			status: "canceled",
			triggerPrice: "90000",
			reduceOnly: true,
		});
	});

	test("an order seen first mid-life falls back to the event time", async () => {
		const h = await live();
		h.pushFutures(
			orderTradeUpdate({ x: "CANCELED", X: "CANCELED" }, 1_800_000_000_777),
		);
		expect(orders(h.calls)[0]?.createdAt).toBe(1_800_000_000_777);
	});

	test("a trailing stop's trigger is its activation price", async () => {
		const h = await live();
		h.pushFutures(
			orderTradeUpdate({
				o: "TRAILING_STOP_MARKET",
				p: "0",
				sp: "7103.04",
				AP: "7476.89",
				cr: "5.0",
			}),
		);
		expect(orders(h.calls)[0]).toMatchObject({
			type: "trailing_stop_market",
			price: null,
			triggerPrice: "7476.89",
		});
	});

	test("a liquidation is a market order and a fill", async () => {
		const h = await live();
		h.pushFutures(
			orderTradeUpdate({
				c: "autoclose-1800000000000",
				S: "SELL",
				o: "LIQUIDATION",
				f: "IOC",
				x: "CALCULATED",
				X: "FILLED",
				l: "0.002",
				z: "0.002",
				L: "60000",
				N: "USDT",
				n: "0.06",
				t: 9100,
				rp: "-20",
			}),
		);
		expect(kinds(h.calls)).toEqual(["order", "fill"]);
		expect(h.calls[0]).toMatchObject([
			"order",
			{ type: "market", status: "filled", timeInForce: "ioc" },
		]);
		expect(h.calls[1]).toMatchObject([
			"fill",
			{
				venueTradeId: "9100",
				fee: "0.06",
				feeAsset: "USDT",
				realizedPnl: "-20",
			},
		]);
	});

	test("a fill without commission fields has fee 0 and no fee asset", async () => {
		const h = await live();
		h.pushFutures(
			orderTradeUpdate({
				x: "TRADE",
				X: "FILLED",
				l: "0.002",
				z: "0.002",
				L: "70000",
				t: 9200,
			}),
		);
		expect(h.calls[1]).toMatchObject(["fill", { fee: "0", feeAsset: "" }]);
	});

	test("an unknown status is a decode error and a re-snapshot on the same sockets", async () => {
		const h = await live();
		h.pushFutures(orderTradeUpdate({ X: "NEW_ADL" }));
		const calls = h.take();
		expect(kinds(calls)).toEqual(["error", "status"]);
		expect(errorOf(calls).message).toContain('"NEW_ADL"');
		expect(calls[1]).toEqual(["status", "resyncing"]);
		await until(() => h.statuses().at(-1) === "live");
		expect(kinds(h.calls)).toEqual(["snapshot", "status"]);
		expect(h.sockets.all).toHaveLength(2);
	});
});

describe("subscribe: futures ALGO_UPDATE", () => {
	test("NEW, TRIGGERED and CANCELED are the order with NEW's creation time", async () => {
		const h = await live();
		h.pushFutures(algoUpdate({}, 1_800_000_000_401));
		h.pushFutures(algoUpdate({ X: "TRIGGERED" }, 1_800_000_000_501));
		h.pushFutures(algoUpdate({ X: "CANCELED" }, 1_800_000_000_601));
		const order: Order = {
			accountId: "acc-1",
			instrumentId: "binance:linear:BTCUSDT",
			venueOrderId: "2148719",
			clientOrderId: "web_algo_1",
			side: "sell",
			type: "take_profit_market",
			status: "new",
			qty: "0.002",
			filledQty: "0",
			price: null,
			triggerPrice: "90000",
			reduceOnly: true,
			timeInForce: "gtc",
			positionSide: "both",
			createdAt: 1_800_000_000_400,
			updatedAt: 1_800_000_000_400,
		};
		expect(h.calls).toEqual([
			["order", order],
			[
				"order",
				{ ...order, status: "triggered", updatedAt: 1_800_000_000_500 },
			],
			["order", { ...order, status: "canceled", updatedAt: 1_800_000_000_600 }],
		]);
	});
});

describe("subscribe: futures ACCOUNT_UPDATE", () => {
	const reads = (h: AccountHarness, path: string) =>
		h.requests.filter((r) => r.startsWith(`GET ${path}?symbol=`));

	test("a position change re-reads that symbol's position over REST", async () => {
		const h = await live();
		h.pushFutures(accountUpdate({ symbols: ["BTCUSDT"] }));
		await until(() => h.calls.length === 1);
		expect(reads(h, "/fapi/v3/positionRisk")).toEqual([
			"GET /fapi/v3/positionRisk?symbol=BTCUSDT",
		]);
		expect(reads(h, "/fapi/v1/symbolConfig")).toEqual([
			"GET /fapi/v1/symbolConfig?symbol=BTCUSDT",
		]);
		expect(h.calls).toEqual([["position", BTC_POSITION]]);
	});

	test("a position the venue no longer returns is emitted with size 0", async () => {
		const h = await live();
		h.route = (req) =>
			req.path === "/fapi/v3/positionRisk" ? Response.json([]) : undefined;
		h.pushFutures(accountUpdate({ symbols: ["BTCUSDT"] }, 1_800_000_000_501));
		await until(() => h.calls.length === 1);
		expect(h.calls).toEqual([
			[
				"position",
				{
					...BTC_POSITION,
					size: "0",
					unrealizedPnl: "0",
					updatedAt: 1_800_000_000_501,
				},
			],
		]);
		// Gone from the cache: a later read with nothing open emits nothing.
		h.pushFutures(accountUpdate({ symbols: ["BTCUSDT"] }, 1_800_000_000_502));
		await until(() => reads(h, "/fapi/v3/positionRisk").length === 2);
		await h.clock.advance(0);
		expect(h.calls).toHaveLength(1);
	});

	test("a balance change re-reads the futures wallet for the named assets", async () => {
		const h = await live();
		h.pushFutures(accountUpdate({ assets: ["USDT", "XRP"] }));
		await until(() => h.calls.length === 2);
		expect(h.requests.at(-1)).toBe("GET /fapi/v3/balance");
		expect(h.calls).toEqual([
			[
				"balance",
				{
					accountId: "acc-1",
					scope: "derivs",
					asset: "USDT",
					free: "4906.40560599",
					locked: "93.43823166",
					total: "4999.84383765",
				},
			],
			[
				"balance",
				{
					accountId: "acc-1",
					scope: "derivs",
					asset: "XRP",
					free: "0",
					locked: "0",
					total: "0",
				},
			],
		]);
	});

	test("updates during a read coalesce into one more read", async () => {
		const h = await live();
		const release = h.hold("/fapi/v3/positionRisk");
		h.pushFutures(accountUpdate({ symbols: ["BTCUSDT"] }, 1_800_000_000_501));
		await until(() => reads(h, "/fapi/v3/positionRisk").length === 1);
		h.pushFutures(accountUpdate({ symbols: ["BTCUSDT"] }, 1_800_000_000_502));
		h.pushFutures(accountUpdate({ symbols: ["BTCUSDT"] }, 1_800_000_000_503));
		h.pushFutures(accountUpdate({ symbols: ["BTCUSDT"] }, 1_800_000_000_504));
		release();
		await until(() => h.calls.length === 2);
		await h.clock.advance(0);
		expect(reads(h, "/fapi/v3/positionRisk")).toHaveLength(2);
		expect(h.calls).toEqual([
			["position", BTC_POSITION],
			["position", BTC_POSITION],
		]);
	});

	test("a failed re-read is an error and a resync", async () => {
		const h = await live();
		h.route = (req) =>
			req.path === "/fapi/v3/positionRisk" && req.params.has("symbol")
				? new Response("oops", { status: 500 })
				: undefined;
		h.pushFutures(accountUpdate({ symbols: ["BTCUSDT"] }));
		await until(() => h.statuses().at(-1) === "live");
		expect(kinds(h.calls)).toEqual(["error", "status", "snapshot", "status"]);
		expect(h.statuses()).toEqual(["resyncing", "live"]);
	});
});

describe("subscribe: futures ACCOUNT_CONFIG_UPDATE", () => {
	test("a leverage change on a held symbol re-reads its position", async () => {
		const h = await live();
		h.pushFutures(leverageUpdate("BTCUSDT", 5));
		await until(() => h.calls.length === 1);
		expect(h.requests.at(-2)).toBe("GET /fapi/v3/positionRisk?symbol=BTCUSDT");
		expect(h.calls).toEqual([["position", BTC_POSITION]]);
	});

	test("a leverage change on another symbol reads nothing", async () => {
		const h = await live();
		const before = h.requests.length;
		h.pushFutures(leverageUpdate("EOSUSDT", 5));
		await h.clock.advance(0);
		expect(h.requests).toHaveLength(before);
		expect(h.calls).toEqual([]);
	});
});

describe("subscribe: ignored events", () => {
	test.each([
		["spot", { e: "balanceUpdate", E: 1, a: "BTC", d: "1.0", T: 1 }],
		["spot", { e: "listStatus", E: 1, s: "BTCUSDT", g: 2, O: [] }],
		["spot", { e: "externalLockUpdate", E: 1, a: "BTC", d: "1.0", T: 1 }],
		["spot", { e: "FOO", E: 1 }],
		["futures", { e: "TRADE_LITE", E: 1, T: 1, s: "BTCUSDT" }],
		["futures", { e: "MARGIN_CALL", E: 1, cw: "1", p: [] }],
		["futures", { e: "STRATEGY_UPDATE", E: 1, T: 1, su: {} }],
		["futures", { e: "GRID_UPDATE", E: 1, T: 1, gu: {} }],
		["futures", { e: "CONDITIONAL_ORDER_TRIGGER_REJECT", E: 1, T: 1, or: {} }],
		["futures", { e: "ACCOUNT_CONFIG_UPDATE", E: 1, T: 1, ai: { j: true } }],
		["futures", { e: "FOO", E: 1 }],
	] as const)("%s %o", async (stream, event) => {
		const h = await live();
		const before = h.requests.length;
		if (stream === "spot") h.pushSpot(event);
		else h.pushFutures(event);
		await h.clock.advance(0);
		expect(h.calls).toEqual([]);
		expect(h.requests).toHaveLength(before);
	});
});

describe("subscribe: end to end over a local server", () => {
	let server: Server<{ path: string }> | undefined;
	let unsubscribe: (() => void) | undefined;
	afterEach(() => {
		unsubscribe?.();
		server?.stop(true);
	});

	test("subscribes, goes live and maps one spot and one futures event", async () => {
		const sockets = new Map<string, ServerWebSocket<{ path: string }>>();
		server = Bun.serve({
			port: 0,
			fetch(req, srv) {
				const path = new URL(req.url).pathname;
				return srv.upgrade(req, { data: { path } })
					? undefined
					: new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open(ws) {
					sockets.set(ws.data.path, ws);
				},
				message(ws, data) {
					const { id } = JSON.parse(String(data)) as { id: string };
					ws.send(JSON.stringify({ id, status: 200, result: {} }));
				},
			},
		});
		const port = server.port;
		class Local extends WebSocket {
			constructor(url: string) {
				super(
					url
						.replace("wss://demo-ws-api.binance.com", `ws://127.0.0.1:${port}`)
						.replace(
							"wss://demo-fstream.binance.com",
							`ws://127.0.0.1:${port}`,
						),
				);
			}
		}
		const { fetch } = replay(await loadScenario("oneway"));
		const adapter = createBinanceAdapter({
			accountId: "acc-1",
			environment: "demo",
			credential: { kind: "hmac", apiKey: "k", secret: "s" },
			fetch: async (url, init) =>
				new URL(url).pathname === "/fapi/v1/listenKey"
					? Response.json({ listenKey: "lk-local" })
					: fetch(url, init),
			WebSocket: Local as unknown as WebSocketCtor,
		});
		const statuses: AccountStatus[] = [];
		const errors: Error[] = [];
		const received: Order[] = [];
		unsubscribe = adapter.subscribe({
			onSnapshot: () => {},
			onBalance: () => {},
			onPosition: () => {},
			onOrder: (o) => received.push(o),
			onFill: () => {},
			onStatus: (s) => statuses.push(s),
			onError: (err) => errors.push(err),
		});
		await until(() => statuses.at(-1) === "live", 5000);
		sockets
			.get("/ws-api/v3")
			?.send(JSON.stringify({ subscriptionId: 0, event: executionReport() }));
		sockets
			.get("/private/ws/lk-local")
			?.send(JSON.stringify(orderTradeUpdate()));
		await until(() => received.length === 2, 5000);
		expect(statuses).toEqual(["connecting", "live"]);
		expect(errors).toEqual([]);
		expect(received.map((o) => o.instrumentId)).toEqual([
			"binance:spot:BTCUSDT",
			"binance:linear:BTCUSDT",
		]);
	});
});
