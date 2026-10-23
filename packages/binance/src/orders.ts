import type {
	Order,
	OrderSide,
	OrderStatus,
	OrderType,
	PositionSide,
	TimeInForce,
} from "@tradedeck/core";
import { z } from "zod";
import { isPositive, venueDecimal } from "./decimal.ts";
import { venueEnum } from "./decode.ts";

// docs/venues/binance.md, Order rules → domain mapping.

export const side = venueEnum(
	{ BUY: "buy", SELL: "sell" } satisfies Record<string, OrderSide>,
	"side",
);

export const positionSide = venueEnum(
	{ BOTH: "both", LONG: "long", SHORT: "short" } satisfies Record<
		string,
		PositionSide
	>,
	"position side",
);

const status = venueEnum(
	{
		NEW: "new",
		PENDING_NEW: "new", // spot: an order-list leg waiting for its trigger leg
		PENDING_CANCEL: "new", // spot: documented as unused
		PARTIALLY_FILLED: "partially_filled",
		FILLED: "filled",
		CANCELED: "canceled",
		REJECTED: "rejected",
		EXPIRED: "expired",
		EXPIRED_IN_MATCH: "expired", // expired by self-trade prevention
	} satisfies Record<string, OrderStatus>,
	"order status",
);

const algoStatus = venueEnum(
	{
		NEW: "new",
		TRIGGERING: "triggered",
		TRIGGERED: "triggered",
		FINISHED: "filled",
		CANCELED: "canceled",
		REJECTED: "rejected",
		EXPIRED: "expired",
	} satisfies Record<string, OrderStatus>,
	"algo status",
);

const timeInForce = venueEnum(
	{
		GTC: "gtc",
		IOC: "ioc",
		FOK: "fok",
		GTX: "post_only", // futures Good-Till-Crossing
		RPI: "post_only", // futures Retail Price Improvement, post-only
		GTD: "gtd",
	} satisfies Record<string, TimeInForce>,
	"time in force",
);

/** `LIMIT_MAKER` is spot's post-only limit order: a type, not a time in force. */
const spotType = venueEnum(
	{
		MARKET: { type: "market", postOnly: false },
		LIMIT: { type: "limit", postOnly: false },
		LIMIT_MAKER: { type: "limit", postOnly: true },
		STOP_LOSS: { type: "stop_market", postOnly: false },
		STOP_LOSS_LIMIT: { type: "stop_limit", postOnly: false },
		TAKE_PROFIT: { type: "take_profit_market", postOnly: false },
		TAKE_PROFIT_LIMIT: { type: "take_profit_limit", postOnly: false },
	} satisfies Record<string, { type: OrderType; postOnly: boolean }>,
	"spot order type",
);

/** Futures `openOrders` types and the Algo Service `orderType`. */
const futuresType = venueEnum(
	{
		MARKET: "market",
		LIMIT: "limit",
		STOP_MARKET: "stop_market",
		STOP: "stop_limit",
		TAKE_PROFIT_MARKET: "take_profit_market",
		TAKE_PROFIT: "take_profit_limit",
		TRAILING_STOP_MARKET: "trailing_stop_market",
	} satisfies Record<string, OrderType>,
	"futures order type",
);

const timestamp = z.number().int().nonnegative();

/** Binance reports an absent price or trigger as zero. */
const positiveOrNull = (value: string | undefined): string | null =>
	value !== undefined && isPositive(value) ? value : null;

export const SpotOpenOrders = z.array(
	z.object({
		symbol: z.string().min(1),
		orderId: z.number().int().nonnegative(),
		clientOrderId: z.string(),
		side,
		type: spotType,
		status,
		timeInForce,
		price: venueDecimal,
		origQty: venueDecimal,
		executedQty: venueDecimal,
		stopPrice: venueDecimal.optional(),
		time: timestamp,
		updateTime: timestamp,
	}),
);

export function spotOrder(
	accountId: string,
	o: z.infer<typeof SpotOpenOrders>[number],
): Order {
	return {
		accountId,
		instrumentId: `binance:spot:${o.symbol}`,
		venueOrderId: String(o.orderId),
		clientOrderId: o.clientOrderId,
		side: o.side,
		type: o.type.type,
		status: o.status,
		qty: o.origQty,
		filledQty: o.executedQty,
		price: positiveOrNull(o.price),
		triggerPrice: positiveOrNull(o.stopPrice),
		reduceOnly: false,
		timeInForce: o.type.postOnly ? "post_only" : o.timeInForce,
		positionSide: "both",
		createdAt: o.time,
		updatedAt: o.updateTime,
	};
}

export const FuturesOpenOrders = z.array(
	z.object({
		symbol: z.string().min(1),
		orderId: z.number().int().nonnegative(),
		clientOrderId: z.string(),
		side,
		positionSide,
		type: futuresType,
		status,
		timeInForce,
		price: venueDecimal,
		origQty: venueDecimal,
		executedQty: venueDecimal,
		stopPrice: venueDecimal.optional(),
		activatePrice: venueDecimal.optional(),
		reduceOnly: z.boolean(),
		closePosition: z.boolean(),
		time: timestamp,
		updateTime: timestamp,
	}),
);

export function futuresOrder(
	accountId: string,
	o: z.infer<typeof FuturesOpenOrders>[number],
): Order {
	return {
		accountId,
		instrumentId: `binance:linear:${o.symbol}`,
		venueOrderId: String(o.orderId),
		clientOrderId: o.clientOrderId,
		side: o.side,
		type: o.type,
		status: o.status,
		qty: o.origQty,
		filledQty: o.executedQty,
		price: positiveOrNull(o.price),
		// A trailing stop's `stopPrice` is meaningless; its trigger is the activation price.
		triggerPrice: positiveOrNull(
			o.type === "trailing_stop_market" ? o.activatePrice : o.stopPrice,
		),
		reduceOnly: o.reduceOnly || o.closePosition,
		timeInForce: o.timeInForce,
		positionSide: o.positionSide,
		createdAt: o.time,
		updatedAt: o.updateTime,
	};
}

export const OpenAlgoOrders = z.array(
	z.object({
		symbol: z.string().min(1),
		algoId: z.number().int().nonnegative(),
		clientAlgoId: z.string(),
		orderType: futuresType,
		side,
		positionSide,
		algoStatus,
		timeInForce,
		/** "0" with `closePosition`: the order closes whatever is open. */
		quantity: venueDecimal,
		price: venueDecimal,
		triggerPrice: venueDecimal,
		activatePrice: venueDecimal.optional(),
		reduceOnly: z.boolean(),
		closePosition: z.boolean(),
		createTime: timestamp,
		updateTime: timestamp,
	}),
);

export function algoOrder(
	accountId: string,
	o: z.infer<typeof OpenAlgoOrders>[number],
): Order {
	return {
		accountId,
		instrumentId: `binance:linear:${o.symbol}`,
		venueOrderId: String(o.algoId),
		clientOrderId: o.clientAlgoId,
		side: o.side,
		type: o.orderType,
		status: o.algoStatus,
		qty: o.quantity,
		filledQty: "0",
		price: positiveOrNull(o.price),
		triggerPrice: positiveOrNull(
			o.orderType === "trailing_stop_market" ? o.activatePrice : o.triggerPrice,
		),
		reduceOnly: o.reduceOnly || o.closePosition,
		timeInForce: o.timeInForce,
		positionSide: o.positionSide,
		createdAt: o.createTime,
		updatedAt: o.updateTime,
	};
}
