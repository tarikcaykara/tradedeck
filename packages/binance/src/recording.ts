import { z } from "zod";
import type { EndpointName } from "./endpoints.ts";
import type { Host } from "./env.ts";

/**
 * One recorded Demo response, as stored under `__recordings__/`. Request
 * headers are never stored, and the request params exclude the auth params.
 */
export interface Recording {
	request: {
		host: Host;
		method: string;
		path: string;
		params: Record<string, string>;
	};
	status: number;
	contentType: string;
	/** The JSON body, or the raw text when the response was not JSON. */
	body: unknown;
	/** What was changed beyond scrubbing, e.g. trimmed symbol lists. */
	note?: string;
}

/**
 * A recorded Demo user-data session, as stored under
 * `__recordings__/demo/streams/`: the raw events of each owner step, in
 * arrival order, scrubbed with `scrubBody`.
 */
export interface StreamRecording {
	note: string;
	steps: Array<{
		name: string;
		instruction: string;
		events: Array<{ stream: "spot" | "futures"; event: unknown }>;
	}>;
}

/** Signed-request params: per-request values that must never be stored. */
export const AUTH_PARAMS: ReadonlySet<string> = new Set([
	"signature",
	"timestamp",
	"recvWindow",
]);

/**
 * Body keys whose values identify the key or the account. Their values are
 * replaced by a placeholder of the same JSON type wherever they appear.
 */
export const SCRUBBED_KEYS: ReadonlySet<string> = new Set([
	"apiKey",
	"listenKey",
	"uid",
	"accountAlias",
	"tradeGroupId",
]);

export const SCRUBBED_STRING = "SCRUBBED";

function placeholder(value: unknown): unknown {
	switch (typeof value) {
		case "string":
			return SCRUBBED_STRING;
		case "number":
			return 0;
		case "boolean":
			return false;
		default:
			return null;
	}
}

/** Deep copy with every `SCRUBBED_KEYS` value replaced. */
export function scrubBody(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(scrubBody);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([k, v]) => [
			k,
			SCRUBBED_KEYS.has(k) ? placeholder(v) : scrubBody(v),
		]),
	);
}

/** Builds a scrubbed recording from a raw exchange. */
export function toRecording(
	exchange: {
		url: string;
		method: string;
		status: number;
		contentType: string;
		text: string;
	},
	hosts: Readonly<Record<Host, string>>,
): Recording {
	const url = new URL(exchange.url);
	const host = (Object.keys(hosts) as Host[]).find(
		(h) => new URL(hosts[h]).origin === url.origin,
	);
	if (host === undefined) {
		throw new Error(`recording: ${url.origin} is not a known host`);
	}
	const params: Record<string, string> = {};
	for (const [k, v] of url.searchParams) {
		if (!AUTH_PARAMS.has(k)) params[k] = v;
	}
	let body: unknown;
	try {
		body = JSON.parse(exchange.text);
	} catch {
		body = exchange.text;
	}
	return {
		request: { host, method: exchange.method, path: url.pathname, params },
		status: exchange.status,
		contentType: exchange.contentType,
		body: scrubBody(body),
	};
}

// Loose shapes: only the fields trimming and picking read; every other key is
// kept, so a trimmed recording is still the venue's response.
const SymbolList = z.array(z.looseObject({ symbol: z.string() }));
const ExchangeInfo = z.looseObject({
	symbols: z.array(
		z.looseObject({
			symbol: z.string(),
			status: z.string(),
			filters: z.array(
				z.looseObject({
					filterType: z.string(),
					stepSize: z.string().optional(),
				}),
			),
		}),
	),
});
const SpotAccount = z.looseObject({
	balances: z.array(z.looseObject({ asset: z.string() })),
});
const FuturesAccount = z.looseObject({ positions: SymbolList });

/**
 * Cuts the per-symbol lists (exchange info, leverage brackets, symbol
 * configs) down to `keep`, so a recording stays reviewable. Other endpoints
 * pass through unchanged.
 */
export function trimSymbols(
	name: EndpointName,
	recording: Recording,
	keep: ReadonlySet<string>,
): Recording {
	if (name === "spotExchangeInfo" || name === "futuresExchangeInfo") {
		const info = ExchangeInfo.safeParse(recording.body);
		if (info.success) {
			const all = info.data.symbols;
			const symbols = all.filter((s) => keep.has(s.symbol));
			return {
				...recording,
				body: { ...info.data, symbols },
				note: `symbols trimmed to ${symbols.length} of ${all.length}`,
			};
		}
	}
	if (name === "leverageBracket" || name === "symbolConfig") {
		const list = SymbolList.safeParse(recording.body);
		if (list.success) {
			const items = list.data.filter((s) => keep.has(s.symbol));
			return {
				...recording,
				body: items,
				note: `entries trimmed to ${items.length} of ${list.data.length}`,
			};
		}
	}
	return recording;
}

/**
 * The symbols a recording keeps: fixed edge cases, the first symbol of each
 * filter quirk, and every symbol the account holds or has an order on.
 */
export function pickSymbols(raw: Partial<Record<EndpointName, unknown>>): {
	spot: Set<string>;
	futures: Set<string>;
} {
	const spot = new Set(["BTCUSDT", "ETHUSDT", "ETHBTC", "币安人生USDT"]);
	const futures = new Set(["BTCUSDT", "ETHUSDT", "币安人生USDT"]);
	const symbolsOf = (body: unknown) =>
		(SymbolList.safeParse(body).data ?? []).map((s) => s.symbol);

	const spotInfo = ExchangeInfo.safeParse(raw.spotExchangeInfo).data;
	const noMarketLot = spotInfo?.symbols.find(
		(s) => !s.filters.some((f) => f.filterType === "MARKET_LOT_SIZE"),
	);
	if (noMarketLot) spot.add(noMarketLot.symbol);
	const balances = SpotAccount.safeParse(raw.spotAccount).data?.balances;
	for (const { asset } of balances ?? []) {
		if (asset !== "USDT") spot.add(`${asset}USDT`);
	}
	for (const s of symbolsOf(raw.spotOpenOrders)) spot.add(s);

	const futuresInfo = ExchangeInfo.safeParse(raw.futuresExchangeInfo).data;
	const notTrading = futuresInfo?.symbols.find((s) => s.status !== "TRADING");
	if (notTrading) futures.add(notTrading.symbol);
	const marketStepDiffers = futuresInfo?.symbols.find((s) => {
		const step = (type: string) =>
			s.filters.find((f) => f.filterType === type)?.stepSize;
		return step("MARKET_LOT_SIZE") !== step("LOT_SIZE");
	});
	if (marketStepDiffers) futures.add(marketStepDiffers.symbol);
	const positions =
		FuturesAccount.safeParse(raw.futuresAccount).data?.positions ?? [];
	for (const s of [
		...symbolsOf(raw.positionRisk),
		...symbolsOf(raw.futuresOpenOrders),
		...symbolsOf(raw.openAlgoOrders),
		...positions.map((p) => p.symbol),
	]) {
		futures.add(s);
	}
	return { spot, futures };
}
