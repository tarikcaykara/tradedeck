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
		[
			"balance with an unknown key",
			{ type: "balance", balance: { ...balance, apiKey: "x" } },
		],
	])("rejects %s", (_, msg) => {
		expect(ServerMessageSchema.safeParse(msg).success).toBe(false);
	});
});

describe("StateSnapshotSchema", () => {
	test("parses a valid state", () => {
		expect(StateSnapshotSchema.parse(state)).toEqual(state);
	});

	test("rejects a numeric tick", () => {
		const malformed = {
			...state,
			instruments: [{ ...instrument, priceRule: { kind: "tick", tick: 0.01 } }],
		};
		expect(StateSnapshotSchema.safeParse(malformed).success).toBe(false);
	});
});
