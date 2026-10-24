import { describe, expect, test } from "bun:test";
import { type Instrument, InstrumentSchema } from "@tradedeck/core";
import { createBinanceAdapter } from "../src/adapter.ts";
import { loadScenario, replay, type Scenario } from "./support/replay.ts";

const credential = { kind: "hmac", apiKey: "k", secret: "s" } as const;

function adapterFor(scenario: Scenario) {
	const r = replay(scenario);
	const adapter = createBinanceAdapter({
		accountId: "acc-1",
		environment: "demo",
		credential,
		fetch: r.fetch,
		now: () => 1_700_000_000_000,
	});
	return { adapter, misses: r.misses };
}

const byId = (list: Instrument[], id: string): Instrument | undefined =>
	list.find((i) => i.id === id);

interface Filter {
	filterType: string;
	tickSize?: string;
	notional?: string;
}

interface ExchangeInfoBody {
	symbols: { symbol: string; filters: Filter[] }[];
}

/** The recorded body of one endpoint, mutable in a cloned scenario. */
function body<T>(scenario: Scenario, name: keyof Scenario): T {
	const recording = scenario[name];
	if (recording === undefined) throw new Error(`no ${name} recording`);
	return recording.body as T;
}

/** One filter of a recorded futures symbol, mutable in a cloned scenario. */
function futuresFilter(
	scenario: Scenario,
	symbol: string,
	type: string,
): Filter {
	const filter = body<ExchangeInfoBody>(scenario, "futuresExchangeInfo")
		.symbols.find((s) => s.symbol === symbol)
		?.filters.find((f) => f.filterType === type);
	if (filter === undefined) throw new Error(`no ${symbol} ${type} recording`);
	return filter;
}

describe("loadInstruments (oneway recordings)", () => {
	test("BTCUSDT spot: exact instrument", async () => {
		const { adapter } = adapterFor(await loadScenario("oneway"));
		const all = await adapter.loadInstruments(["spot", "linear"]);
		expect(byId(all, "binance:spot:BTCUSDT")).toEqual({
			id: "binance:spot:BTCUSDT",
			venue: "binance",
			kind: "spot",
			symbol: "BTCUSDT",
			base: "BTC",
			quote: "USDT",
			settle: null,
			priceRule: { kind: "tick", tick: "0.01000000" },
			qtyRule: {
				step: "0.00001000",
				marketStep: "0.00001000",
				minQty: "0.00001000",
			},
			minNotional: "5.00000000",
			maxLeverage: null,
		});
	});

	test("BTCUSDT linear: exact instrument, maxLeverage from bracket 1", async () => {
		const { adapter } = adapterFor(await loadScenario("oneway"));
		const all = await adapter.loadInstruments(["spot", "linear"]);
		expect(byId(all, "binance:linear:BTCUSDT")).toEqual({
			id: "binance:linear:BTCUSDT",
			venue: "binance",
			kind: "linear",
			symbol: "BTCUSDT",
			base: "BTC",
			quote: "USDT",
			settle: "USDT",
			priceRule: { kind: "tick", tick: "0.10" },
			qtyRule: { step: "0.0001", marketStep: "0.0001", minQty: "0.0001" },
			minNotional: "50",
			maxLeverage: 125,
		});
	});

	test("spot ETHBTC: MARKET_LOT_SIZE step 0 falls back to the lot step", async () => {
		const { adapter } = adapterFor(await loadScenario("oneway"));
		const i = byId(
			await adapter.loadInstruments(["spot"]),
			"binance:spot:ETHBTC",
		);
		expect(i).toMatchObject({
			base: "ETH",
			quote: "BTC",
			priceRule: { kind: "tick", tick: "0.00001000" },
			qtyRule: {
				step: "0.00010000",
				marketStep: "0.00010000",
				minQty: "0.00010000",
			},
			minNotional: "0.00010000",
		});
	});

	test("spot symbol without a MARKET_LOT_SIZE filter: marketStep = lot step", async () => {
		const scenario = structuredClone(await loadScenario("oneway"));
		const sym = body<ExchangeInfoBody>(
			scenario,
			"spotExchangeInfo",
		).symbols.find((s) => s.symbol === "USDCUSDT");
		if (sym === undefined) throw new Error("no USDCUSDT recording");
		sym.filters = sym.filters.filter((f) => f.filterType !== "MARKET_LOT_SIZE");
		const { adapter } = adapterFor(scenario);
		const i = byId(
			await adapter.loadInstruments(["spot"]),
			"binance:spot:USDCUSDT",
		);
		expect(i?.qtyRule).toEqual({
			step: "1.00000000",
			marketStep: "1.00000000",
			minQty: "1.00000000",
		});
		expect(i?.priceRule).toEqual({ kind: "tick", tick: "0.00001000" });
	});

	test("futures ARKUSDT: marketStep is the MARKET_LOT_SIZE step when it differs", async () => {
		const { adapter } = adapterFor(await loadScenario("oneway"));
		const i = byId(
			await adapter.loadInstruments(["linear"]),
			"binance:linear:ARKUSDT",
		);
		expect(i).toMatchObject({
			priceRule: { kind: "tick", tick: "0.0001000" },
			qtyRule: { step: "3", marketStep: "1", minQty: "3" },
			minNotional: "5",
			maxLeverage: 10,
		});
	});

	test("non-TRADING futures symbol (EOSUSDT SETTLING) is absent", async () => {
		const { adapter } = adapterFor(await loadScenario("oneway"));
		const ids: string[] = (await adapter.loadInstruments(["linear"])).map(
			(i) => i.id,
		);
		expect(ids).not.toContain("binance:linear:EOSUSDT");
		expect(ids.sort()).toEqual(
			[
				"binance:linear:ARKUSDT",
				"binance:linear:BTCUSDT",
				"binance:linear:ETHUSDT",
				"binance:linear:币安人生USDT",
			].sort(),
		);
	});

	test("non-ASCII symbol maps on both kinds", async () => {
		const { adapter } = adapterFor(await loadScenario("oneway"));
		const all = await adapter.loadInstruments(["spot", "linear"]);
		expect(byId(all, "binance:linear:币安人生USDT")).toEqual({
			id: "binance:linear:币安人生USDT",
			venue: "binance",
			kind: "linear",
			symbol: "币安人生USDT",
			base: "币安人生",
			quote: "USDT",
			settle: "USDT",
			priceRule: { kind: "tick", tick: "0.0000100" },
			qtyRule: { step: "1", marketStep: "1", minQty: "1" },
			minNotional: "5",
			maxLeverage: 50,
		});
		expect(byId(all, "binance:spot:币安人生USDT")).toEqual({
			id: "binance:spot:币安人生USDT",
			venue: "binance",
			kind: "spot",
			symbol: "币安人生USDT",
			base: "币安人生",
			quote: "USDT",
			settle: null,
			priceRule: { kind: "tick", tick: "0.00010000" },
			qtyRule: {
				step: "0.10000000",
				marketStep: "0.10000000",
				minQty: "0.10000000",
			},
			minNotional: "1.00000000",
			maxLeverage: null,
		});
	});

	test("futures symbol with no bracket row: maxLeverage null", async () => {
		const scenario = structuredClone(await loadScenario("oneway"));
		const brackets = scenario.leverageBracket;
		if (brackets === undefined) throw new Error("no leverageBracket recording");
		brackets.body = body<{ symbol: string }[]>(
			scenario,
			"leverageBracket",
		).filter((b) => b.symbol !== "ETHUSDT");
		const { adapter } = adapterFor(scenario);
		const all = await adapter.loadInstruments(["linear"]);
		expect(byId(all, "binance:linear:ETHUSDT")?.maxLeverage).toBeNull();
		expect(byId(all, "binance:linear:BTCUSDT")?.maxLeverage).toBe(125);
	});

	test("a zero tick drops the symbol", async () => {
		const scenario = structuredClone(await loadScenario("oneway"));
		futuresFilter(scenario, "ETHUSDT", "PRICE_FILTER").tickSize = "0";
		const { adapter } = adapterFor(scenario);
		const ids = (await adapter.loadInstruments(["linear"])).map((i) => i.id);
		expect(ids).not.toContain("binance:linear:ETHUSDT");
		expect(ids).toContain("binance:linear:BTCUSDT");
	});

	test("a zero minimum notional means no minimum: the symbol is kept", async () => {
		const scenario = structuredClone(await loadScenario("oneway"));
		futuresFilter(scenario, "ETHUSDT", "MIN_NOTIONAL").notional = "0";
		const { adapter } = adapterFor(scenario);
		const all = await adapter.loadInstruments(["linear"]);
		expect(byId(all, "binance:linear:ETHUSDT")?.minNotional).toBe("0");
	});

	test("inverse is rejected", async () => {
		const { adapter } = adapterFor(await loadScenario("oneway"));
		await expect(adapter.loadInstruments(["inverse"])).rejects.toThrow(
			"binance: inverse instruments are not supported",
		);
	});

	test("every instrument passes InstrumentSchema; nothing unrecorded requested", async () => {
		const { adapter, misses } = adapterFor(await loadScenario("oneway"));
		const all = await adapter.loadInstruments(["spot", "linear"]);
		expect(all).toHaveLength(9);
		for (const i of all) expect(() => InstrumentSchema.parse(i)).not.toThrow();
		expect(misses).toEqual([]);
	});
});
