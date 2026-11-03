import type {
	AccountSnapshot,
	Balance,
	Instrument,
	Order,
	Position,
} from "@tradedeck/core";
import type { AccountRow } from "@tradedeck/db";

// Dummy values only. Times are venue times in ms.
export const T0 = 1_800_000_000_000;

export const DEMO: AccountRow = {
	id: "acc-demo",
	venue: "binance",
	label: "binance-demo",
	environment: "demo",
	credentialKind: "hmac",
	createdAt: T0,
};

export const LIVE: AccountRow = {
	...DEMO,
	id: "acc-live",
	label: "binance-live",
	environment: "live",
	createdAt: T0 + 1,
};

export function instrument(
	kind: "spot" | "linear",
	base: string,
	quote = "USDT",
): Instrument {
	const symbol = `${base}${quote}`;
	return {
		id: `binance:${kind}:${symbol}`,
		venue: "binance",
		kind,
		symbol,
		base,
		quote,
		settle: kind === "linear" ? quote : null,
		priceRule: { kind: "tick", tick: "0.01" },
		qtyRule: { step: "0.001", marketStep: "0.001", minQty: "0.001" },
		minNotional: "5",
		maxLeverage: kind === "linear" ? 125 : null,
	};
}

export const BTC_SPOT = instrument("spot", "BTC");
export const ETH_SPOT = instrument("spot", "ETH");
export const ETH_BTC = instrument("spot", "ETH", "BTC");
export const BTC_PERP = instrument("linear", "BTC");
export const ETH_PERP = instrument("linear", "ETH");
export const INSTRUMENTS = [BTC_SPOT, ETH_SPOT, ETH_BTC, BTC_PERP, ETH_PERP];

export function balance(asset: string, total: string, updatedAt = T0): Balance {
	return {
		accountId: DEMO.id,
		scope: "spot",
		asset,
		free: total,
		locked: "0",
		total,
		updatedAt,
	};
}

export function position(size: string, updatedAt = T0): Position {
	return {
		accountId: DEMO.id,
		instrumentId: BTC_PERP.id,
		side: "long",
		positionSide: "both",
		size,
		entryPrice: "80000",
		markPrice: "80100",
		liquidationPrice: null,
		unrealizedPnl: "1",
		leverage: 7,
		marginMode: "cross",
		updatedAt,
	};
}

export function order(
	status: Order["status"],
	updatedAt = T0,
	instrumentId: Order["instrumentId"] = ETH_BTC.id,
): Order {
	return {
		accountId: DEMO.id,
		instrumentId,
		venueOrderId: "9001",
		clientOrderId: "web-1",
		side: "buy",
		type: "limit",
		status,
		qty: "1",
		filledQty: "0",
		price: "0.03",
		triggerPrice: null,
		reduceOnly: false,
		timeInForce: "gtc",
		positionSide: "both",
		createdAt: T0,
		updatedAt,
	};
}

export function snapshot(
	parts: Partial<
		Pick<AccountSnapshot, "balances" | "positions" | "openOrders">
	> = {},
): AccountSnapshot {
	return {
		accountId: DEMO.id,
		balances: parts.balances ?? [balance("USDT", "100"), balance("BTC", "0.5")],
		positions: parts.positions ?? [position("0.01")],
		openOrders: parts.openOrders ?? [order("new")],
		fetchedAt: T0,
	};
}
