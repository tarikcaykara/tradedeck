import { z } from "zod";
import { DECIMAL_STRING } from "./decimal.ts";

// docs/architecture.md §4. The schemas are the single source of truth; every
// type is inferred from its schema. Objects are strict: an unknown key — say a
// credential spread into a delta — fails validation instead of reaching the UI.

/** Milliseconds since the Unix epoch. */
const Timestamp = z.number().int().nonnegative();

export const DecimalStringSchema = z.string().regex(DECIMAL_STRING);
export type DecimalString = z.infer<typeof DecimalStringSchema>;

export const VenueSchema = z.enum(["binance"]);
export type Venue = z.infer<typeof VenueSchema>;

export const EnvironmentSchema = z.enum(["live", "demo"]);
export type Environment = z.infer<typeof EnvironmentSchema>;

/** Binance USDⓈ-M is `linear`. M1–M3 implement `spot` and `linear` only. */
export const InstrumentKindSchema = z.enum(["spot", "linear", "inverse"]);
export type InstrumentKind = z.infer<typeof InstrumentKindSchema>;

/**
 * `${venue}:${kind}:${symbol}`, e.g. "binance:linear:BTCUSDT". The symbol has
 * no character set: Hyperliquid HIP-3 symbols contain ":".
 */
export const InstrumentIdSchema = z.templateLiteral([
	VenueSchema,
	":",
	InstrumentKindSchema,
	":",
	z.string().min(1),
]);
export type InstrumentId = z.infer<typeof InstrumentIdSchema>;

export const OrderSideSchema = z.enum(["buy", "sell"]);
export type OrderSide = z.infer<typeof OrderSideSchema>;

/** `both` is one-way mode. */
export const PositionSideSchema = z.enum(["both", "long", "short"]);
export type PositionSide = z.infer<typeof PositionSideSchema>;

export const MarginModeSchema = z.enum(["cross", "isolated"]);
export type MarginMode = z.infer<typeof MarginModeSchema>;

export const OrderTypeSchema = z.enum([
	"market",
	"limit",
	"stop_market",
	"stop_limit",
	"take_profit_market",
	"take_profit_limit",
	"trailing_stop_market",
]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const OrderStatusSchema = z.enum([
	"new",
	"partially_filled",
	"filled",
	"canceled",
	"rejected",
	"expired",
	"triggered",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/** `gtd`: Binance futures Good-Till-Date, an order that expires at a set time. */
export const TimeInForceSchema = z.enum([
	"gtc",
	"ioc",
	"fok",
	"post_only",
	"gtd",
]);
export type TimeInForce = z.infer<typeof TimeInForceSchema>;

export const AccountStatusSchema = z.enum([
	"connecting",
	"live",
	"resyncing",
	"down",
]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/** Plain data so it serializes to the UI; applied by `roundPrice`. */
export const PriceRuleSchema = z.discriminatedUnion("kind", [
	// Binance, Bybit, Aster
	z.strictObject({ kind: z.literal("tick"), tick: DecimalStringSchema }),
	// Hyperliquid
	z.strictObject({
		kind: z.literal("sigfig"),
		sigFigs: z.number().int().min(1),
		maxDecimals: z.number().int().min(0),
	}),
]);
export type PriceRule = z.infer<typeof PriceRuleSchema>;

/** Plain data so it serializes to the UI; `step` is applied by `roundQty`. */
export const QtyRuleSchema = z.strictObject({
	step: DecimalStringSchema,
	marketStep: DecimalStringSchema,
	minQty: DecimalStringSchema,
});
export type QtyRule = z.infer<typeof QtyRuleSchema>;

export const InstrumentSchema = z.strictObject({
	id: InstrumentIdSchema,
	venue: VenueSchema,
	kind: InstrumentKindSchema,
	/** Venue symbol, e.g. "BTCUSDT". */
	symbol: z.string(),
	base: z.string(),
	quote: z.string(),
	/** `null` for spot. */
	settle: z.string().nullable(),
	priceRule: PriceRuleSchema,
	qtyRule: QtyRuleSchema,
	minNotional: DecimalStringSchema,
	/** `null` for spot. */
	maxLeverage: z.number().int().positive().nullable(),
});
export type Instrument = z.infer<typeof InstrumentSchema>;

export const BalanceSchema = z.strictObject({
	accountId: z.string(),
	scope: z.enum(["spot", "derivs", "unified"]),
	asset: z.string(),
	free: DecimalStringSchema,
	locked: DecimalStringSchema,
	total: DecimalStringSchema,
});
export type Balance = z.infer<typeof BalanceSchema>;

export const PositionSchema = z.strictObject({
	accountId: z.string(),
	instrumentId: InstrumentIdSchema,
	side: z.enum(["long", "short"]),
	positionSide: PositionSideSchema,
	/**
	 * Never negative; the direction is `side`. "0" is a closed position (§6).
	 * A signed venue amount (Binance `positionAmt`) must be split by the adapter.
	 */
	size: DecimalStringSchema.refine(
		(s) => !s.startsWith("-"),
		"size must not be negative",
	),
	entryPrice: DecimalStringSchema,
	markPrice: DecimalStringSchema,
	liquidationPrice: DecimalStringSchema.nullable(),
	unrealizedPnl: DecimalStringSchema,
	leverage: z.number().int().positive(),
	marginMode: MarginModeSchema,
	/** Venue event time. */
	updatedAt: Timestamp,
});
export type Position = z.infer<typeof PositionSchema>;

export const OrderSchema = z.strictObject({
	accountId: z.string(),
	instrumentId: InstrumentIdSchema,
	/** Opaque; algo orders use the algo id. */
	venueOrderId: z.string(),
	clientOrderId: z.string(),
	side: OrderSideSchema,
	type: OrderTypeSchema,
	status: OrderStatusSchema,
	qty: DecimalStringSchema,
	filledQty: DecimalStringSchema,
	price: DecimalStringSchema.nullable(),
	triggerPrice: DecimalStringSchema.nullable(),
	reduceOnly: z.boolean(),
	timeInForce: TimeInForceSchema,
	positionSide: PositionSideSchema,
	createdAt: Timestamp,
	updatedAt: Timestamp,
});
export type Order = z.infer<typeof OrderSchema>;

export const FillSchema = z.strictObject({
	accountId: z.string(),
	instrumentId: InstrumentIdSchema,
	venueTradeId: z.string(),
	venueOrderId: z.string(),
	side: OrderSideSchema,
	qty: DecimalStringSchema,
	price: DecimalStringSchema,
	fee: DecimalStringSchema,
	feeAsset: z.string(),
	/** `null` for spot. */
	realizedPnl: DecimalStringSchema.nullable(),
	ts: Timestamp,
});
export type Fill = z.infer<typeof FillSchema>;

export const AccountSnapshotSchema = z.strictObject({
	accountId: z.string(),
	balances: z.array(BalanceSchema),
	positions: z.array(PositionSchema),
	/** Conditional (algo) orders included. */
	openOrders: z.array(OrderSchema),
	fetchedAt: Timestamp,
});
export type AccountSnapshot = z.infer<typeof AccountSnapshotSchema>;

/** Futures mark price or spot last price; `subscribePrices` and the `price` message. */
export const PriceUpdateSchema = z.strictObject({
	instrumentId: InstrumentIdSchema,
	price: DecimalStringSchema,
	kind: z.enum(["mark", "last"]),
	ts: Timestamp,
});
export type PriceUpdate = z.infer<typeof PriceUpdateSchema>;

/** docs/architecture.md §5. */
export const CredentialReportSchema = z.strictObject({
	canRead: z.boolean(),
	canTradeSpot: z.boolean(),
	canTradeDerivs: z.boolean(),
	canWithdraw: z.boolean(),
	ipRestricted: z.boolean(),
});
export type CredentialReport = z.infer<typeof CredentialReportSchema>;

/**
 * docs/architecture.md §5. Future kinds are added with their venue: `rsa`
 * (Bybit), `evm_agent` (Hyperliquid, Aster V3), `zk_api_key` (Lighter).
 */
export const CredentialSchema = z.discriminatedUnion("kind", [
	// Binance default
	z.strictObject({
		kind: z.literal("ed25519"),
		apiKey: z.string(),
		privateKeyPem: z.string(),
	}),
	z.strictObject({
		kind: z.literal("hmac"),
		apiKey: z.string(),
		secret: z.string(),
	}),
]);
export type Credential = z.infer<typeof CredentialSchema>;
