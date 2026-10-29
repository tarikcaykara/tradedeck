import type { Balance, Fill, Order } from "@tradedeck/core";
import { z } from "zod";
import { add, isZero, venueDecimal } from "./decimal.ts";
import { decode } from "./decode.ts";
import {
	algoStatus,
	futuresType,
	positionSide,
	positiveOrNull,
	side,
	spotType,
	status,
	timeInForce,
	timestamp,
} from "./orders.ts";

// docs/venues/binance.md, Private streams. Loose objects: only the fields the
// mapping reads are checked; every other field may come and go.

const MISSING_FEE_ASSET = "commission asset missing on a fill";

const ExecutionReport = z
	.object({
		E: timestamp,
		s: z.string().min(1),
		c: z.string(),
		/** The canceled order's own client id on a cancel, else "". */
		C: z.string().nullish(),
		S: side,
		o: spotType,
		f: timeInForce,
		q: venueDecimal,
		p: venueDecimal,
		P: venueDecimal,
		x: z.string(),
		X: status,
		i: z.number().int().nonnegative(),
		l: venueDecimal,
		z: venueDecimal,
		L: venueDecimal,
		n: venueDecimal,
		N: z.string().nullable(),
		T: timestamp,
		/** -1 without a trade. */
		t: z.number().int(),
		/** Order creation time. */
		O: timestamp,
	})
	.refine((r) => r.x !== "TRADE" || r.N !== null || isZero(r.n), {
		message: MISSING_FEE_ASSET,
		path: ["N"],
	});
export type ExecutionReport = z.infer<typeof ExecutionReport>;

const OutboundAccountPosition = z.object({
	E: timestamp,
	B: z.array(z.object({ a: z.string(), f: venueDecimal, l: venueDecimal })),
});
export type SpotBalanceRow = z.infer<
	typeof OutboundAccountPosition
>["B"][number];

/** Execution types that carry a trade; `CALCULATED` is a liquidation's. */
const isTrade = (x: string): boolean => x === "TRADE" || x === "CALCULATED";

const OrderTradeUpdate = z.object({
	E: timestamp,
	o: z
		.object({
			s: z.string().min(1),
			c: z.string(),
			S: side,
			o: futuresType,
			f: timeInForce,
			q: venueDecimal,
			p: venueDecimal,
			sp: venueDecimal,
			/** Execution type: NEW, CANCELED, CALCULATED (liquidation), EXPIRED, TRADE, AMENDMENT. */
			x: z.string(),
			X: status,
			i: z.number().int().nonnegative(),
			l: venueDecimal,
			z: venueDecimal,
			L: venueDecimal,
			/** Both absent without commission. */
			N: z.string().optional(),
			n: venueDecimal.optional(),
			T: timestamp,
			t: z.number().int(),
			R: z.boolean(),
			ps: positionSide,
			cp: z.boolean(),
			/** Trailing stop activation price. */
			AP: venueDecimal.optional(),
			rp: venueDecimal,
		})
		.refine(
			(o) =>
				!isTrade(o.x) || o.N !== undefined || o.n === undefined || isZero(o.n),
			{ message: MISSING_FEE_ASSET, path: ["N"] },
		),
});
export type FuturesOrderUpdate = z.infer<typeof OrderTradeUpdate>["o"];

const AlgoUpdate = z.object({
	E: timestamp,
	T: timestamp,
	o: z.object({
		caid: z.string(),
		aid: z.number().int().nonnegative(),
		o: futuresType,
		s: z.string().min(1),
		S: side,
		ps: positionSide,
		f: timeInForce,
		q: venueDecimal,
		X: algoStatus,
		tp: venueDecimal,
		p: venueDecimal,
		R: z.boolean(),
		cp: z.boolean(),
	}),
});
export type AlgoOrderUpdate = z.infer<typeof AlgoUpdate>["o"];

const AccountUpdate = z.object({
	E: timestamp,
	a: z.object({
		B: z.array(z.object({ a: z.string() })).default([]),
		P: z.array(z.object({ s: z.string().min(1) })).default([]),
	}),
});

const AccountConfigUpdate = z.object({
	E: timestamp,
	ac: z.object({ s: z.string().min(1), l: z.number() }).optional(),
});

/** A decoded event the subscription applies; `E` is the venue event time. */
export type StreamEvent =
	| { kind: "spotOrder"; E: number; report: ExecutionReport }
	| { kind: "spotBalances"; E: number; rows: SpotBalanceRow[] }
	| { kind: "futuresOrder"; E: number; order: FuturesOrderUpdate }
	| { kind: "algoOrder"; E: number; T: number; algo: AlgoOrderUpdate }
	/** Positions on `symbols` and balances of `assets` changed. */
	| { kind: "accountUpdate"; E: number; symbols: string[]; assets: string[] }
	/** The leverage of `symbol` changed. */
	| { kind: "leverage"; E: number; symbol: string };

const EventType = z.object({ e: z.string() });

/**
 * A spot user-data event, or null for a type the subscription does not use:
 * `balanceUpdate` and `externalLockUpdate` (deltas; the absolute
 * `outboundAccountPosition` follows), `listStatus` (its legs arrive as
 * `executionReport`s) and any type not known yet. A known type that does not
 * match its schema throws a `decode` VenueError (`method: "WS"`).
 */
export function decodeSpotEvent(raw: unknown): StreamEvent | null {
	const e = EventType.safeParse(raw).data?.e;
	const at = { method: "WS", path: `spot ${e}` };
	switch (e) {
		case "executionReport": {
			const report = decode(ExecutionReport, raw, at);
			return { kind: "spotOrder", E: report.E, report };
		}
		case "outboundAccountPosition": {
			const { E, B } = decode(OutboundAccountPosition, raw, at);
			return { kind: "spotBalances", E, rows: B };
		}
		default:
			return null;
	}
}

/**
 * A futures user-data event, or null for a type the subscription does not
 * use: `TRADE_LITE` (the same trade as `ORDER_TRADE_UPDATE`), `MARGIN_CALL`,
 * `STRATEGY_UPDATE`, `GRID_UPDATE`, `CONDITIONAL_ORDER_TRIGGER_REJECT` (the
 * rejection arrives as `ALGO_UPDATE`), `ACCOUNT_CONFIG_UPDATE` without a
 * leverage change, and any type not known yet. A known type that does not
 * match its schema throws a `decode` VenueError (`method: "WS"`).
 */
export function decodeFuturesEvent(raw: unknown): StreamEvent | null {
	const e = EventType.safeParse(raw).data?.e;
	const at = { method: "WS", path: `futures ${e}` };
	switch (e) {
		case "ORDER_TRADE_UPDATE": {
			const { E, o } = decode(OrderTradeUpdate, raw, at);
			return { kind: "futuresOrder", E, order: o };
		}
		case "ALGO_UPDATE": {
			const { E, T, o } = decode(AlgoUpdate, raw, at);
			return { kind: "algoOrder", E, T, algo: o };
		}
		case "ACCOUNT_UPDATE": {
			const { E, a } = decode(AccountUpdate, raw, at);
			return {
				kind: "accountUpdate",
				E,
				symbols: [...new Set(a.P.map((p) => p.s))],
				assets: [...new Set(a.B.map((b) => b.a))],
			};
		}
		case "ACCOUNT_CONFIG_UPDATE": {
			const { E, ac } = decode(AccountConfigUpdate, raw, at);
			return ac === undefined ? null : { kind: "leverage", E, symbol: ac.s };
		}
		default:
			return null;
	}
}

export function spotOrderOf(accountId: string, r: ExecutionReport): Order {
	return {
		accountId,
		instrumentId: `binance:spot:${r.s}`,
		venueOrderId: String(r.i),
		// On a cancel, `c` is the cancel request's id and `C` the order's own.
		clientOrderId: r.C ? r.C : r.c,
		side: r.S,
		type: r.o.type,
		status: r.X,
		qty: r.q,
		filledQty: r.z,
		price: positiveOrNull(r.p),
		triggerPrice: positiveOrNull(r.P),
		reduceOnly: false,
		timeInForce: r.o.postOnly ? "post_only" : r.f,
		positionSide: "both",
		createdAt: r.O,
		updatedAt: r.T,
	};
}

/** The trade an `executionReport` carries, or null when it is not a trade. */
export function spotFillOf(accountId: string, r: ExecutionReport): Fill | null {
	if (r.x !== "TRADE") return null;
	return {
		accountId,
		instrumentId: `binance:spot:${r.s}`,
		venueTradeId: String(r.t),
		venueOrderId: String(r.i),
		side: r.S,
		qty: r.l,
		price: r.L,
		fee: r.n,
		feeAsset: r.N ?? "",
		realizedPnl: null,
		ts: r.T,
	};
}

/** `outboundAccountPosition` rows are absolute, not deltas. */
export function spotBalanceOf(accountId: string, row: SpotBalanceRow): Balance {
	return {
		accountId,
		scope: "spot",
		asset: row.a,
		free: row.f,
		locked: row.l,
		total: add(row.f, row.l),
	};
}

/** `createdAt` comes from the caller: futures events carry no creation time. */
export function futuresOrderOf(
	accountId: string,
	o: FuturesOrderUpdate,
	createdAt: number,
): Order {
	return {
		accountId,
		instrumentId: `binance:linear:${o.s}`,
		venueOrderId: String(o.i),
		clientOrderId: o.c,
		side: o.S,
		type: o.o,
		status: o.X,
		qty: o.q,
		filledQty: o.z,
		price: positiveOrNull(o.p),
		// A trailing stop's `sp` is meaningless; its trigger is the activation price.
		triggerPrice: positiveOrNull(o.o === "trailing_stop_market" ? o.AP : o.sp),
		reduceOnly: o.R || o.cp,
		timeInForce: o.f,
		positionSide: o.ps,
		createdAt,
		updatedAt: o.T,
	};
}

/** The trade an update carries (a liquidation's included), or null. */
export function futuresFillOf(
	accountId: string,
	o: FuturesOrderUpdate,
): Fill | null {
	if (!isTrade(o.x)) return null;
	return {
		accountId,
		instrumentId: `binance:linear:${o.s}`,
		venueTradeId: String(o.t),
		venueOrderId: String(o.i),
		side: o.S,
		qty: o.l,
		price: o.L,
		fee: o.n ?? "0",
		feeAsset: o.N ?? "",
		realizedPnl: o.rp,
		ts: o.T,
	};
}

/**
 * `T` is the event's transaction time; `createdAt` comes from the caller.
 * `tp` is taken as the trigger of a trailing stop too: the event carries no
 * activation price.
 */
export function algoOrderOf(
	accountId: string,
	algo: AlgoOrderUpdate,
	T: number,
	createdAt: number,
): Order {
	return {
		accountId,
		instrumentId: `binance:linear:${algo.s}`,
		venueOrderId: String(algo.aid),
		clientOrderId: algo.caid,
		side: algo.S,
		type: algo.o,
		status: algo.X,
		qty: algo.q,
		filledQty: "0",
		price: positiveOrNull(algo.p),
		triggerPrice: positiveOrNull(algo.tp),
		reduceOnly: algo.R || algo.cp,
		timeInForce: algo.f,
		positionSide: algo.ps,
		createdAt,
		updatedAt: T,
	};
}
