import { describe, expect, test } from "bun:test";
import { VenueError } from "@tradedeck/adapter";
import { type AccountSnapshot, AccountSnapshotSchema } from "@tradedeck/core";
import { createBinanceAdapter } from "../src/adapter.ts";
import { loadScenario, replay, type Scenario } from "./support/replay.ts";

const credential = { kind: "hmac", apiKey: "k", secret: "s" } as const;
const NOW = 1_800_000_000_000;

async function snapshot(scenario: Scenario): Promise<AccountSnapshot> {
	const { fetch } = replay(scenario);
	const adapter = createBinanceAdapter({
		accountId: "acc-1",
		environment: "demo",
		credential,
		fetch,
		now: () => NOW,
	});
	return adapter.fetchSnapshot();
}

/** A deep copy of a recorded scenario, to mutate one field of. */
async function clone(name: "oneway" | "hedge"): Promise<Scenario> {
	return structuredClone(await loadScenario(name));
}

/** The array body of a recorded endpoint, for in-test mutation. */
function rows<T>(scenario: Scenario, endpoint: keyof Scenario): T[] {
	return scenario[endpoint]?.body as T[];
}

function rejection(p: Promise<unknown>): Promise<unknown> {
	return p.then(
		() => undefined,
		(e: unknown) => e,
	);
}

describe("fetchSnapshot, one-way recording", () => {
	test("is exactly the hand-derived snapshot", async () => {
		const snap = await snapshot(await loadScenario("oneway"));
		expect(snap).toEqual({
			accountId: "acc-1",
			balances: [
				// Spot: total = free + locked, trailing zeros dropped by the sum.
				{
					accountId: "acc-1",
					scope: "spot",
					asset: "BTC",
					free: "0.00011988",
					locked: "0.00000000",
					total: "0.00011988",
				},
				{
					accountId: "acc-1",
					scope: "spot",
					asset: "USDT",
					free: "4985.36734080",
					locked: "5.00000000",
					total: "4990.3673408",
				},
				{
					accountId: "acc-1",
					scope: "spot",
					asset: "USDC",
					free: "5000.00000000",
					locked: "0.00000000",
					total: "5000",
				},
				// Derivs: total = balance, free = maxWithdrawAmount, locked = difference;
				// FDUSD, U, BNB, ETH, USD1 are all-zero rows and dropped.
				{
					accountId: "acc-1",
					scope: "derivs",
					asset: "BTC",
					free: "0.01000000",
					locked: "0",
					total: "0.01000000",
				},
				{
					accountId: "acc-1",
					scope: "derivs",
					asset: "USDT",
					free: "4906.40560599",
					locked: "93.43823166",
					total: "4999.84383765",
				},
				{
					accountId: "acc-1",
					scope: "derivs",
					asset: "USDC",
					free: "5000.00000000",
					locked: "0",
					total: "5000.00000000",
				},
			],
			positions: [
				{
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
				},
				{
					accountId: "acc-1",
					instrumentId: "binance:linear:ETHUSDT",
					side: "short",
					positionSide: "both",
					size: "0.085",
					entryPrice: "2324.44",
					markPrice: "2332.88003317",
					liquidationPrice: "3084.08915411",
					unrealizedPnl: "-0.71740281",
					leverage: 3,
					marginMode: "isolated",
					updatedAt: 1792865722110,
				},
			],
			openOrders: [
				{
					accountId: "acc-1",
					instrumentId: "binance:spot:BTCUSDT",
					venueOrderId: "76569010727",
					clientOrderId: "web_6a9dec3439a24e6ea0bfc1d2527933e2",
					side: "buy",
					type: "limit",
					status: "new",
					qty: "0.00010000",
					filledQty: "0.00000000",
					price: "50000.00000000",
					triggerPrice: null,
					reduceOnly: false,
					timeInForce: "gtc",
					positionSide: "both",
					createdAt: 1792865224407,
					updatedAt: 1792865224407,
				},
				{
					accountId: "acc-1",
					instrumentId: "binance:linear:BTCUSDT",
					venueOrderId: "28650413040",
					clientOrderId: "web_st_tZatSH4J3euuiWF",
					side: "sell",
					type: "take_profit_market",
					status: "new",
					qty: "0.0024",
					filledQty: "0",
					price: null,
					triggerPrice: "90000",
					reduceOnly: true,
					// Recorded as "GTE_GTC" (good till expired, GTC); see the report.
					timeInForce: "gtc",
					positionSide: "both",
					createdAt: 1792865622588,
					updatedAt: 1792865622588,
				},
				{
					accountId: "acc-1",
					instrumentId: "binance:linear:BTCUSDT",
					venueOrderId: "28650413041",
					clientOrderId: "web_st_cZHetpcq2F4ZQKN",
					side: "sell",
					type: "stop_market",
					status: "new",
					qty: "0.0024",
					filledQty: "0",
					price: null,
					triggerPrice: "75000",
					reduceOnly: true,
					timeInForce: "gtc",
					positionSide: "both",
					createdAt: 1792865622588,
					updatedAt: 1792865622588,
				},
			],
			fetchedAt: NOW,
		});
	});

	test("passes the strict AccountSnapshotSchema", async () => {
		const snap = await snapshot(await loadScenario("oneway"));
		expect(() => AccountSnapshotSchema.parse(snap)).not.toThrow();
	});
});

describe("fetchSnapshot, hedge recording", () => {
	test("positions take their side from positionSide; the TP is an algo order", async () => {
		const snap = await snapshot(await loadScenario("hedge"));
		expect(snap.positions).toEqual([
			{
				accountId: "acc-1",
				instrumentId: "binance:linear:BTCUSDT",
				side: "long",
				positionSide: "long",
				size: "0.0018",
				entryPrice: "80349.90000000001",
				markPrice: "80291.69653986",
				liquidationPrice: "249929135.69920683",
				unrealizedPnl: "-0.10476622",
				leverage: 7,
				marginMode: "cross",
				updatedAt: 1792866928130,
			},
			{
				accountId: "acc-1",
				instrumentId: "binance:linear:BTCUSDT",
				side: "short",
				positionSide: "short",
				size: "0.0018",
				entryPrice: "80323.1",
				markPrice: "80291.69653986",
				liquidationPrice: "249929135.69920683",
				unrealizedPnl: "0.05652622",
				leverage: 7,
				marginMode: "cross",
				updatedAt: 1792866979996,
			},
		]);
		// Futures openOrders is empty here: spot order, then the algo order.
		expect(snap.openOrders).toHaveLength(2);
		expect(snap.openOrders[1]).toEqual({
			accountId: "acc-1",
			instrumentId: "binance:linear:BTCUSDT",
			venueOrderId: "1000000255801971",
			clientOrderId: "web_algo_coin_mekyocnm22w8vp1nwm",
			side: "sell",
			type: "take_profit_market",
			status: "new",
			qty: "0.0018",
			filledQty: "0",
			price: null,
			triggerPrice: "80400.0",
			reduceOnly: true,
			timeInForce: "gtc",
			positionSide: "long",
			createdAt: 1792867035782,
			updatedAt: 1792867035783,
		});
		expect(snap.fetchedAt).toBe(NOW);
	});

	test("passes the strict AccountSnapshotSchema", async () => {
		const snap = await snapshot(await loadScenario("hedge"));
		expect(() => AccountSnapshotSchema.parse(snap)).not.toThrow();
	});
});

describe("fetchSnapshot, mutated recordings", () => {
	test("a zero positionAmt row is dropped", async () => {
		const s = await clone("oneway");
		const eth = rows<{ positionAmt: string; liquidationPrice: string }>(
			s,
			"positionRisk",
		)[1];
		if (eth === undefined) throw new Error("fixture");
		eth.positionAmt = "0";
		const snap = await snapshot(s);
		expect(snap.positions.map((p) => p.instrumentId)).toEqual([
			"binance:linear:BTCUSDT",
		]);
		expect(() => AccountSnapshotSchema.parse(snap)).not.toThrow();
	});

	test('liquidationPrice "0" maps to null', async () => {
		const s = await clone("oneway");
		const eth = rows<{ positionAmt: string; liquidationPrice: string }>(
			s,
			"positionRisk",
		)[1];
		if (eth === undefined) throw new Error("fixture");
		eth.liquidationPrice = "0";
		const snap = await snapshot(s);
		expect(snap.positions.map((p) => p.liquidationPrice)).toEqual([null, null]);
	});

	test("a futures maxWithdrawAmount above the balance clamps locked to 0", async () => {
		const s = await clone("oneway");
		const usdt = rows<{
			asset: string;
			balance: string;
			maxWithdrawAmount: string;
		}>(s, "futuresBalance").find((b) => b.asset === "USDT");
		if (usdt === undefined) throw new Error("fixture");
		usdt.balance = "1.5";
		usdt.maxWithdrawAmount = "2.25";
		const snap = await snapshot(s);
		expect(
			snap.balances.find((b) => b.scope === "derivs" && b.asset === "USDT"),
		).toEqual({
			accountId: "acc-1",
			scope: "derivs",
			asset: "USDT",
			free: "2.25",
			locked: "0",
			total: "1.5",
		});
		expect(() => AccountSnapshotSchema.parse(snap)).not.toThrow();
	});

	test("a futures row with zero balance but non-zero maxWithdrawAmount is kept", async () => {
		const s = await clone("oneway");
		const eth = rows<{
			asset: string;
			balance: string;
			maxWithdrawAmount: string;
		}>(s, "futuresBalance").find((b) => b.asset === "ETH");
		if (eth === undefined) throw new Error("fixture");
		eth.maxWithdrawAmount = "0.5";
		const snap = await snapshot(s);
		expect(
			snap.balances.find((b) => b.scope === "derivs" && b.asset === "ETH"),
		).toEqual({
			accountId: "acc-1",
			scope: "derivs",
			asset: "ETH",
			free: "0.5",
			locked: "0",
			total: "0.00000000",
		});
	});

	test("an unknown futures order type rejects with a decode VenueError", async () => {
		const s = await clone("oneway");
		const order = rows<{ type: string }>(s, "futuresOpenOrders")[0];
		if (order === undefined) throw new Error("fixture");
		order.type = "SOMETHING_NEW";
		const e = await rejection(snapshot(s));
		expect(e).toBeInstanceOf(VenueError);
		expect(e).toMatchObject({ kind: "decode", path: "/fapi/v1/openOrders" });
		expect((e as VenueError).message).toContain("unknown futures order type");
	});

	test("an unknown spot order type rejects with a decode VenueError", async () => {
		const s = await clone("oneway");
		const order = rows<{ type: string }>(s, "spotOpenOrders")[0];
		if (order === undefined) throw new Error("fixture");
		order.type = "SOMETHING_NEW";
		const e = await rejection(snapshot(s));
		expect(e).toBeInstanceOf(VenueError);
		expect(e).toMatchObject({ kind: "decode", path: "/api/v3/openOrders" });
		expect((e as VenueError).message).toContain("unknown spot order type");
	});

	test("a position symbol missing from symbolConfig rejects with a decode VenueError", async () => {
		const s = await clone("oneway");
		const cfg = s.symbolConfig;
		if (cfg === undefined) throw new Error("fixture");
		cfg.body = (cfg.body as { symbol: string }[]).filter(
			(c) => c.symbol !== "BTCUSDT",
		);
		const e = await rejection(snapshot(s));
		expect(e).toBeInstanceOf(VenueError);
		expect(e).toMatchObject({ kind: "decode", path: "/fapi/v1/symbolConfig" });
		expect((e as VenueError).message).toContain("no symbol configuration");
	});

	test("zero rows everywhere give an empty but valid snapshot", async () => {
		const s = await clone("oneway");
		for (const name of [
			"futuresBalance",
			"positionRisk",
			"futuresOpenOrders",
			"openAlgoOrders",
			"spotOpenOrders",
		] as const) {
			const r = s[name];
			if (r === undefined) throw new Error("fixture");
			r.body = [];
		}
		const sa = s.spotAccount;
		if (sa === undefined) throw new Error("fixture");
		(sa.body as { balances: unknown[] }).balances = [];
		const snap = await snapshot(s);
		expect(snap).toEqual({
			accountId: "acc-1",
			balances: [],
			positions: [],
			openOrders: [],
			fetchedAt: NOW,
		});
		expect(() => AccountSnapshotSchema.parse(snap)).not.toThrow();
	});
});
