import { describe, expect, test } from "bun:test";
import type {
	AccountSnapshot,
	Balance,
	Fill,
	Instrument,
	Order,
	Position,
} from "../src/domain.ts";
import {
	type AccountSummary,
	type ServerMessage,
	ServerMessageSchema,
	type StateSnapshot,
	StateSnapshotSchema,
} from "../src/protocol.ts";

// Typed fixtures: `bun run typecheck` proves each sample conforms to the
// inferred types.
const ts = 1_760_000_000_000;

const instrument: Instrument = {
	id: "binance:linear:BTCUSDT",
	venue: "binance",
	kind: "linear",
	symbol: "BTCUSDT",
	base: "BTC",
	quote: "USDT",
	settle: "USDT",
	priceRule: { kind: "tick", tick: "0.10" },
	qtyRule: { step: "0.001", marketStep: "0.001", minQty: "0.001" },
	minNotional: "100",
	maxLeverage: 125,
};

const balance: Balance = {
	accountId: "acc-1",
	scope: "derivs",
	asset: "USDT",
	free: "1000.5",
	locked: "0",
	total: "1000.5",
	updatedAt: 1_700_000_000_000,
};

const position: Position = {
	accountId: "acc-1",
	instrumentId: "binance:linear:BTCUSDT",
	side: "long",
	positionSide: "both",
	size: "0.01",
	entryPrice: "65000",
	markPrice: "65500.5",
	liquidationPrice: "58650.2",
	unrealizedPnl: "5.005",
	leverage: 10,
	marginMode: "cross",
	updatedAt: ts,
};

const order: Order = {
	accountId: "acc-1",
	instrumentId: "binance:linear:BTCUSDT",
	venueOrderId: "4000000001",
	clientOrderId: "td-1",
	side: "sell",
	type: "stop_market",
	status: "new",
	qty: "0.01",
	filledQty: "0",
	price: null,
	triggerPrice: "60000",
	reduceOnly: true,
	timeInForce: "gtc",
	positionSide: "both",
	createdAt: ts,
	updatedAt: ts,
};

const fill: Fill = {
	accountId: "acc-1",
	instrumentId: "binance:linear:BTCUSDT",
	venueTradeId: "5000000001",
	venueOrderId: "4000000000",
	side: "sell",
	qty: "0.01",
	price: "65150",
	fee: "0.2606",
	feeAsset: "USDT",
	realizedPnl: "1.5",
	ts,
};

const snapshot: AccountSnapshot = {
	accountId: "acc-1",
	balances: [balance],
	positions: [position],
	openOrders: [order],
	fetchedAt: ts,
};

const account: AccountSummary = {
	id: "acc-1",
	label: "Binance demo",
	venue: "binance",
	environment: "demo",
	status: "live",
};

const state: StateSnapshot = {
	accounts: [account],
	instruments: [instrument],
	snapshots: [snapshot],
};

const price = {
	type: "price",
	instrumentId: "binance:linear:BTCUSDT",
	price: "65500.5",
	kind: "mark",
	ts,
} as const satisfies ServerMessage;

const messages: ServerMessage[] = [
	{ type: "snapshot", state },
	{ type: "balance", balance },
	{ type: "position", position },
	{ type: "order", order },
	{ type: "fill", fill },
	price,
	{ type: "account_status", accountId: "acc-1", status: "resyncing" },
];

describe("ServerMessageSchema", () => {
	test("the valid samples cover every message type", () => {
		const types = ServerMessageSchema.options.map((o) => o.shape.type.value);
		expect(messages.map((m) => m.type).sort()).toEqual(types.sort());
	});

	test.each(messages.map((m) => [m.type, m] as const))(
		"parses a valid %s message",
		(_, msg) => {
			expect(ServerMessageSchema.parse(msg)).toEqual(msg);
		},
	);

	const { liquidationPrice: _liquidationPrice, ...positionWithoutLiquidation } =
		position;

	test.each<[string, unknown]>([
		[
			"snapshot with an unknown environment",
			{
				type: "snapshot",
				state: { ...state, accounts: [{ ...account, environment: "testnet" }] },
			},
		],
		[
			"balance with a number amount",
			{ type: "balance", balance: { ...balance, free: 1.5 } },
		],
		[
			"position without liquidationPrice (absent is not null)",
			{ type: "position", position: positionWithoutLiquidation },
		],
		[
			"position with a signed (negative) size",
			{ type: "position", position: { ...position, size: "-0.01" } },
		],
		[
			"order with an unknown status",
			{ type: "order", order: { ...order, status: "open" } },
		],
		[
			"fill with an exponent price",
			{ type: "fill", fill: { ...fill, price: "1e5" } },
		],
		[
			"price with an unknown instrument kind",
			{ ...price, instrumentId: "binance:futures:BTCUSDT" },
		],
		[
			"price with an empty symbol",
			{ ...price, instrumentId: "binance:linear:" },
		],
		[
			"account_status with an unknown status",
			{ type: "account_status", accountId: "acc-1", status: "ok" },
		],
		["an unknown type", { type: "heartbeat" }],
		["price with a negative price", { ...price, price: "-1" }],
		[
			"position with a negative entry price",
			{ type: "position", position: { ...position, entryPrice: "-65000" } },
		],
		[
			"position with a negative mark price",
			{ type: "position", position: { ...position, markPrice: "-1" } },
		],
		[
			"position with a zero liquidation price (null means none)",
			{ type: "position", position: { ...position, liquidationPrice: "0" } },
		],
		[
			"order with a negative qty",
			{ type: "order", order: { ...order, qty: "-0.01" } },
		],
		[
			"order with a negative filled qty",
			{ type: "order", order: { ...order, filledQty: "-0.01" } },
		],
		[
			"order with a zero price (null means none)",
			{ type: "order", order: { ...order, price: "0" } },
		],
		[
			"order with a negative trigger price",
			{ type: "order", order: { ...order, triggerPrice: "-60000" } },
		],
		[
			"fill with a negative qty",
			{ type: "fill", fill: { ...fill, qty: "-1" } },
		],
		[
			"fill with a negative price",
			{ type: "fill", fill: { ...fill, price: "-65150" } },
		],
		[
			"fill with 21 fraction digits",
			{ type: "fill", fill: { ...fill, price: "1.000000000000000000001" } },
		],
		[
			"balance with 21 integer digits",
			{
				type: "balance",
				balance: { ...balance, total: "100000000000000000000" },
			},
		],
		[
			"balance with an unknown key",
			{ type: "balance", balance: { ...balance, apiKey: "x" } },
		],
	])("rejects %s", (_, msg) => {
		expect(ServerMessageSchema.safeParse(msg).success).toBe(false);
	});

	test.each<[string, ServerMessage]>([
		[
			"a negative balance (multi-assets mode)",
			{
				type: "balance",
				balance: { ...balance, free: "-12.5", total: "-12.5" },
			},
		],
		[
			"a negative unrealized PnL",
			{ type: "position", position: { ...position, unrealizedPnl: "-3.2" } },
		],
		[
			"a closed position of size 0",
			{ type: "position", position: { ...position, size: "0" } },
		],
		[
			"a closePosition order of qty 0",
			{ type: "order", order: { ...order, qty: "0" } },
		],
		[
			"a fee rebate and a realized loss",
			{ type: "fill", fill: { ...fill, fee: "-0.01", realizedPnl: "-4" } },
		],
		[
			"20 integer and 20 fraction digits, leading and trailing zeros aside",
			{
				type: "fill",
				fill: {
					...fill,
					qty: "0099999999999999999999.99999999999999999999000",
				},
			},
		],
	])("accepts %s", (_, msg) => {
		expect(ServerMessageSchema.parse(msg)).toEqual(msg);
	});
});

describe("StateSnapshotSchema", () => {
	test("parses a valid state", () => {
		expect(StateSnapshotSchema.parse(state)).toEqual(state);
	});

	test.each<[string, Record<string, unknown>]>([
		["a numeric tick", { priceRule: { kind: "tick", tick: 0.01 } }],
		["a zero tick", { priceRule: { kind: "tick", tick: "0" } }],
		["a negative tick", { priceRule: { kind: "tick", tick: "-0.10" } }],
		[
			"a zero step",
			{ qtyRule: { step: "0", marketStep: "0.001", minQty: "0.001" } },
		],
		[
			"a zero market step",
			{ qtyRule: { step: "0.001", marketStep: "0", minQty: "0.001" } },
		],
		[
			"a negative minimum quantity",
			{ qtyRule: { step: "0.001", marketStep: "0.001", minQty: "-1" } },
		],
		["a negative minimum notional", { minNotional: "-100" }],
		["an id naming another symbol", { id: "binance:linear:ETHUSDT" }],
		["an id naming another kind", { id: "binance:spot:BTCUSDT" }],
	])("rejects an instrument with %s", (_, change) => {
		const malformed = {
			...state,
			instruments: [{ ...instrument, ...change }],
		};
		expect(StateSnapshotSchema.safeParse(malformed).success).toBe(false);
	});

	test("accepts an instrument without minimums (0 is no minimum)", () => {
		const free: StateSnapshot = {
			...state,
			instruments: [
				{
					...instrument,
					qtyRule: { ...instrument.qtyRule, minQty: "0" },
					minNotional: "0",
				},
			],
		};
		expect(StateSnapshotSchema.parse(free)).toEqual(free);
	});
});
