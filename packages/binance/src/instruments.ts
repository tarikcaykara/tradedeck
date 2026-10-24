import type { Instrument, InstrumentKind } from "@tradedeck/core";
import { z } from "zod";
import { isPositive, venueDecimal } from "./decimal.ts";
import { ENDPOINTS } from "./endpoints.ts";
import type { BinanceHttp } from "./http.ts";

// Only the filter fields the rules use; other filters and fields are dropped.
const Filter = z.object({
	filterType: z.string(),
	tickSize: venueDecimal.optional(),
	stepSize: venueDecimal.optional(),
	minQty: venueDecimal.optional(),
	minNotional: venueDecimal.optional(), // spot NOTIONAL / MIN_NOTIONAL
	notional: venueDecimal.optional(), // futures MIN_NOTIONAL
});

const ExchangeInfo = z.object({
	symbols: z.array(
		z.object({
			symbol: z.string().min(1),
			status: z.string(),
			baseAsset: z.string(),
			quoteAsset: z.string(),
			marginAsset: z.string().optional(),
			filters: z.array(Filter),
		}),
	),
});
type ExchangeSymbol = z.infer<typeof ExchangeInfo>["symbols"][number];

const LeverageBrackets = z.array(
	z.object({
		symbol: z.string(),
		brackets: z.array(
			z.object({
				bracket: z.number().int(),
				initialLeverage: z.number().int().positive(),
			}),
		),
	}),
);

/**
 * Builds an instrument, or `null` when its rules are unusable: a zero or
 * missing tick or step (rounding needs both), or a missing minimum. A zero
 * minimum means "no minimum" and is kept. Positions and orders on a dropped
 * symbol still map by id.
 */
function toInstrument(
	kind: "spot" | "linear",
	s: ExchangeSymbol,
	maxLeverage: number | null,
): Instrument | null {
	const filter = (type: string) => s.filters.find((f) => f.filterType === type);
	const tick = filter("PRICE_FILTER")?.tickSize;
	const lot = filter("LOT_SIZE");
	// Spot reports MARKET_LOT_SIZE.stepSize "0" (or omits the filter) for
	// almost every symbol: market orders then follow LOT_SIZE.
	const marketStep = filter("MARKET_LOT_SIZE")?.stepSize;
	const minNotional =
		kind === "spot"
			? (filter("NOTIONAL")?.minNotional ?? filter("MIN_NOTIONAL")?.minNotional)
			: filter("MIN_NOTIONAL")?.notional;
	const settle = kind === "spot" ? null : (s.marginAsset ?? null);
	if (
		tick === undefined ||
		!isPositive(tick) ||
		lot?.stepSize === undefined ||
		!isPositive(lot.stepSize) ||
		lot.minQty === undefined ||
		minNotional === undefined ||
		(kind === "linear" && settle === null)
	) {
		return null;
	}
	return {
		id: `binance:${kind}:${s.symbol}`,
		venue: "binance",
		kind,
		symbol: s.symbol,
		base: s.baseAsset,
		quote: s.quoteAsset,
		settle,
		priceRule: { kind: "tick", tick },
		qtyRule: {
			step: lot.stepSize,
			marketStep:
				marketStep !== undefined && isPositive(marketStep)
					? marketStep
					: lot.stepSize,
			minQty: lot.minQty,
		},
		minNotional,
		maxLeverage,
	};
}

async function spotInstruments(http: BinanceHttp): Promise<Instrument[]> {
	// `symbolStatus=TRADING` in the endpoint: 6 MB instead of 18 MB.
	const info = await http.get(ENDPOINTS.spotExchangeInfo, ExchangeInfo);
	return info.symbols.flatMap((s) => toInstrument("spot", s, null) ?? []);
}

async function linearInstruments(http: BinanceHttp): Promise<Instrument[]> {
	const [info, brackets] = await Promise.all([
		http.get(ENDPOINTS.futuresExchangeInfo, ExchangeInfo),
		http.get(ENDPOINTS.leverageBracket, LeverageBrackets),
	]);
	// Max leverage is bracket 1's initial leverage (docs/venues/binance.md).
	const maxLeverage = new Map(
		brackets.flatMap(({ symbol, brackets }) => {
			const first = brackets.find((b) => b.bracket === 1);
			return first === undefined ? [] : [[symbol, first.initialLeverage]];
		}),
	);
	return info.symbols.flatMap((s) =>
		s.status === "TRADING"
			? (toInstrument("linear", s, maxLeverage.get(s.symbol) ?? null) ?? [])
			: [],
	);
}

export async function loadInstruments(
	http: BinanceHttp,
	kinds: readonly InstrumentKind[],
): Promise<Instrument[]> {
	if (kinds.includes("inverse")) {
		throw new Error("binance: inverse instruments are not supported");
	}
	const lists = await Promise.all([
		kinds.includes("spot") ? spotInstruments(http) : [],
		kinds.includes("linear") ? linearInstruments(http) : [],
	]);
	return lists.flat();
}
