import { afterEach, describe, expect, test } from "bun:test";
import type { Balance, Fill, Order, Position } from "@tradedeck/core";
import type { StreamRecording } from "../src/recording.ts";
import {
	type AccountHarness,
	BTC_POSITION,
	type Call,
	startAccount,
} from "./support/account.ts";
import { until } from "./support/wait.ts";

const RECORDING = `${import.meta.dir}/../__recordings__/demo/streams/user-data.json`;

let harness: AccountHarness | undefined;
afterEach(() => {
	harness?.unsubscribe();
	harness = undefined;
});

interface ByKind {
	orders: Order[];
	fills: Fill[];
	balances: Balance[];
	positions: Position[];
	other: Call[];
}

/**
 * The calls grouped by kind, in order inside each kind. Position and balance
 * re-reads finish in an order the test must not depend on.
 */
function byKind(calls: Call[]): ByKind {
	const out: ByKind = {
		orders: [],
		fills: [],
		balances: [],
		positions: [],
		other: [],
	};
	for (const call of calls) {
		if (call[0] === "order") out.orders.push(call[1]);
		else if (call[0] === "fill") out.fills.push(call[1]);
		else if (call[0] === "balance") out.balances.push(call[1]);
		else if (call[0] === "position") out.positions.push(call[1]);
		else out.other.push(call);
	}
	return out;
}

const expected = (calls: Partial<ByKind>): ByKind => ({
	orders: [],
	fills: [],
	balances: [],
	positions: [],
	other: [],
	...calls,
});

const spotBalance = (
	asset: string,
	free: string,
	locked: string,
	total: string,
): Balance => ({
	accountId: "acc-1",
	scope: "spot",
	asset,
	free,
	locked,
	total,
});

const SPOT_ZERO_BNB = spotBalance("BNB", "0.00000000", "0.00000000", "0");
const SPOT_BTC = spotBalance("BTC", "0.00011988", "0.00000000", "0.00011988");
const SPOT_USDT_FREE = spotBalance(
	"USDT",
	"4990.36734080",
	"0.00000000",
	"4990.3673408",
);

/** Spot limit buy A: placed and cancelled inside step 1. */
const SPOT_A: Order = {
	accountId: "acc-1",
	instrumentId: "binance:spot:BTCUSDT",
	venueOrderId: "78592622219",
	clientOrderId: "web_5ff2638ed3e848de9eb5b813cc83ccf2",
	side: "buy",
	type: "limit",
	status: "new",
	qty: "0.00020000",
	filledQty: "0.00000000",
	price: "76644.01000000",
	triggerPrice: null,
	reduceOnly: false,
	timeInForce: "gtc",
	positionSide: "both",
	createdAt: 1793389191107,
	updatedAt: 1793389191107,
};

/** Spot limit buy B: placed in step 1, cancelled in step 2. */
const SPOT_B: Order = {
	...SPOT_A,
	venueOrderId: "78592954735",
	clientOrderId: "web_e6e55fc62947453c8ac1dd17d6f32bef",
	price: "76544.01000000",
	createdAt: 1793389280901,
	updatedAt: 1793389280901,
};

const SPOT_MARKET: Order = {
	...SPOT_A,
	venueOrderId: "78593857332",
	clientOrderId: "web_124ca54cb5794d94a1b9a0c58d22f27b",
	type: "market",
	qty: "0.00013000",
	price: null,
	createdAt: 1793389522157,
	updatedAt: 1793389522157,
};

const FUTURES_LONG: Order = {
	accountId: "acc-1",
	instrumentId: "binance:linear:BTCUSDT",
	venueOrderId: "28658798569",
	clientOrderId: "web_coin_4sx7c89vdfktr5eti7cbbss",
	side: "buy",
	type: "market",
	status: "new",
	qty: "0.002",
	filledQty: "0",
	price: null,
	triggerPrice: null,
	reduceOnly: false,
	timeInForce: "gtc",
	positionSide: "both",
	createdAt: 1793389715659,
	updatedAt: 1793389715659,
};

/** `createdAt` stays the `NEW` event's `o.T` through the amendment and the cancel. */
const FUTURES_LIMIT: Order = {
	...FUTURES_LONG,
	venueOrderId: "28658806668",
	clientOrderId: "web_RzAKlzuTSV7j3udRpNxr",
	side: "sell",
	type: "limit",
	price: "84400",
	reduceOnly: true,
	createdAt: 1793390067083,
	updatedAt: 1793390067083,
};

/** A `closePosition` take-profit: the venue sends `q` "0". */
const FUTURES_TP: Order = {
	...FUTURES_LONG,
	venueOrderId: "1000000265969676",
	clientOrderId: "web_algo_coin_lcy9mbs6l948o1dlj9",
	side: "sell",
	type: "take_profit_market",
	qty: "0",
	triggerPrice: "80550",
	reduceOnly: true,
	createdAt: 1793390298347,
	updatedAt: 1793390298347,
};

const FUTURES_CLOSE: Order = {
	...FUTURES_LONG,
	venueOrderId: "28658814656",
	clientOrderId: "web_vHhLeFNrAQu5fbIpwNpl",
	side: "sell",
	reduceOnly: true,
	createdAt: 1793390386059,
	updatedAt: 1793390386059,
};

const futuresFill = (
	fill: Pick<Fill, "venueTradeId" | "venueOrderId" | "side" | "qty" | "price">,
	fee: string,
	realizedPnl: string,
	ts: number,
): Fill => ({
	accountId: "acc-1",
	instrumentId: "binance:linear:BTCUSDT",
	...fill,
	fee,
	feeAsset: "USDT",
	realizedPnl,
	ts,
});

/** The `oneway` recording's `/fapi/v3/balance` USDT row. */
const USDT_DERIVS: Balance = {
	accountId: "acc-1",
	scope: "derivs",
	asset: "USDT",
	free: "4906.40560599",
	locked: "93.43823166",
	total: "4999.84383765",
};

// Futures positions and wallet balances are REST re-reads (decision
// 2026-10-29), answered by the harness from the 2026-10-24 oneway REST
// recording, so their values are that recording's, not this session's.
const EXPECTED: Record<string, ByKind> = {
	"spot-limit-new": expected({
		orders: [
			SPOT_A,
			{ ...SPOT_A, status: "canceled", updatedAt: 1793389263450 },
			SPOT_B,
		],
		balances: [
			SPOT_BTC,
			SPOT_ZERO_BNB,
			spotBalance("USDT", "4975.03853880", "15.32880200", "4990.3673408"),
			SPOT_BTC,
			SPOT_ZERO_BNB,
			SPOT_USDT_FREE,
			SPOT_BTC,
			SPOT_ZERO_BNB,
			spotBalance("USDT", "4975.05853880", "15.30880200", "4990.3673408"),
		],
	}),
	"spot-limit-cancel": expected({
		orders: [{ ...SPOT_B, status: "canceled", updatedAt: 1793389435939 }],
		balances: [SPOT_BTC, SPOT_ZERO_BNB, SPOT_USDT_FREE],
	}),
	"spot-market-buy": expected({
		orders: [
			SPOT_MARKET,
			{ ...SPOT_MARKET, status: "filled", filledQty: "0.00013000" },
		],
		fills: [
			{
				accountId: "acc-1",
				instrumentId: "binance:spot:BTCUSDT",
				venueTradeId: "334119476",
				venueOrderId: "78593857332",
				side: "buy",
				qty: "0.00013000",
				price: "76680.01000000",
				fee: "0.00000013",
				feeAsset: "BTC",
				realizedPnl: null,
				ts: 1793389522157,
			},
		],
		balances: [
			spotBalance("BTC", "0.00024975", "0.00000000", "0.00024975"),
			SPOT_ZERO_BNB,
			spotBalance("USDT", "4980.39893950", "0.00000000", "4980.3989395"),
		],
	}),
	// The oneway snapshot holds a BTCUSDT position, so the leverage event re-reads it.
	"futures-leverage": expected({ positions: [BTC_POSITION] }),
	"futures-open-long": expected({
		orders: [
			FUTURES_LONG,
			{ ...FUTURES_LONG, status: "filled", filledQty: "0.002" },
		],
		fills: [
			futuresFill(
				{
					venueTradeId: "552534992",
					venueOrderId: "28658798569",
					side: "buy",
					qty: "0.002",
					price: "76713.1",
				},
				"0.06137048",
				"0",
				1793389715659,
			),
		],
		positions: [BTC_POSITION],
		balances: [USDT_DERIVS],
	}),
	"futures-limit-amend-cancel": expected({
		orders: [
			FUTURES_LIMIT,
			{ ...FUTURES_LIMIT, price: "85900", updatedAt: 1793390151951 },
			{
				...FUTURES_LIMIT,
				status: "canceled",
				price: "85900",
				updatedAt: 1793390216099,
			},
		],
	}),
	"futures-tp-new-cancel": expected({
		orders: [
			FUTURES_TP,
			{ ...FUTURES_TP, status: "canceled", updatedAt: 1793390377395 },
		],
	}),
	"futures-close": expected({
		orders: [
			FUTURES_CLOSE,
			{ ...FUTURES_CLOSE, status: "partially_filled", filledQty: "0.001" },
			{ ...FUTURES_CLOSE, status: "filled", filledQty: "0.002" },
		],
		fills: [
			futuresFill(
				{
					venueTradeId: "552537200",
					venueOrderId: "28658814656",
					side: "sell",
					qty: "0.001",
					price: "76893.2",
				},
				"0.03075728",
				"0.1801",
				1793390386059,
			),
			futuresFill(
				{
					venueTradeId: "552537201",
					venueOrderId: "28658814656",
					side: "sell",
					qty: "0.001",
					price: "76877.1",
				},
				"0.03075084",
				"0.164",
				1793390386059,
			),
		],
		positions: [
			BTC_POSITION,
			{
				...BTC_POSITION,
				size: "0",
				unrealizedPnl: "0",
				updatedAt: 1793390386094,
			},
		],
		balances: [USDT_DERIVS, USDT_DERIVS],
	}),
	"network-cut": expected({}),
};

/** The raw event fields the replay loop reads. */
interface RawEvent {
	e?: string;
	a?: { P?: Array<{ pa?: string }> };
}

describe("recorded Demo user-data events (2026-10-30)", () => {
	test("replay step by step through one live account", async () => {
		const recording = (await Bun.file(RECORDING).json()) as StreamRecording;
		expect(recording.steps.map((s) => s.name)).toEqual(Object.keys(EXPECTED));

		// One account for every step: a futures order's createdAt comes from
		// the NEW seen earlier in the same session.
		const h = await startAccount();
		harness = h;
		await h.goLive();
		h.take();
		const firstRequest = h.requests.length;
		const count = (kind: Call[0]) =>
			h.calls.filter((c) => c[0] === kind).length;

		for (const step of recording.steps) {
			for (const { stream, event } of step.events) {
				const raw = event as RawEvent;
				if (raw.e === "ACCOUNT_UPDATE" && raw.a?.P?.[0]?.pa === "0") {
					// The final close: the venue no longer returns the position.
					h.route = (req) =>
						req.path === "/fapi/v3/positionRisk" &&
						req.params.get("symbol") === "BTCUSDT"
							? Response.json([])
							: undefined;
				}
				const positions = count("position");
				const balances = count("balance");
				if (stream === "spot") h.pushSpot(event);
				else h.pushFutures(event);
				// Each re-read finishes before the next push, so none coalesce.
				if (raw.e === "ACCOUNT_UPDATE") {
					await until(
						() => count("position") > positions && count("balance") > balances,
					);
				} else if (raw.e === "ACCOUNT_CONFIG_UPDATE") {
					await until(() => count("position") > positions);
				}
			}
			const want = EXPECTED[step.name];
			if (want === undefined) throw new Error(`no expectation: ${step.name}`);
			await h.clock.advance(0);
			expect({ step: step.name, ...byKind(h.take()) }).toEqual({
				step: step.name,
				...want,
			});
		}

		const later = h.requests.slice(firstRequest);
		expect(
			later.filter((r) => r.startsWith("GET /fapi/v3/positionRisk?symbol=")),
		).toEqual(Array(4).fill("GET /fapi/v3/positionRisk?symbol=BTCUSDT"));
		expect(later.filter((r) => r === "GET /fapi/v3/balance")).toHaveLength(3);
	});
});
