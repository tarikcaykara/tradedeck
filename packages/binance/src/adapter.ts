import type {
	ExchangeAdapter,
	Fetch,
	KindCapabilities,
} from "@tradedeck/adapter";
import type { Credential, Environment, InstrumentKind } from "@tradedeck/core";
import { verifyCredential } from "./credential.ts";
import { createBinanceHttp } from "./http.ts";
import { loadInstruments } from "./instruments.ts";
import { fetchSnapshot } from "./snapshot.ts";

/**
 * The members implemented so far. `subscribe` (M1 issue 7),
 * `subscribePrices` (issue 8) and `fetchFills` (issue 12) widen this to
 * `ExchangeAdapter` as they land; nothing is stubbed.
 */
export type BinanceAdapter = Pick<
	ExchangeAdapter,
	| "venue"
	| "capabilities"
	| "verifyCredential"
	| "loadInstruments"
	| "fetchSnapshot"
>;

/** Architecture §5, Binance values. */
const CAPABILITIES: Partial<Record<InstrumentKind, KindCapabilities>> = {
	spot: {
		amend: "qty_down_or_cancel_replace",
		cancelAll: "per_symbol",
		closePosition: "emulated",
		hedgeMode: false,
		batchMax: 1,
		conditionalOrders: "inline",
	},
	linear: {
		amend: "limit_only",
		cancelAll: "per_symbol",
		closePosition: "emulated",
		hedgeMode: true,
		batchMax: 5,
		conditionalOrders: "separate_api",
	},
};

export function createBinanceAdapter(opts: {
	/** Stamped on every balance, position and order. */
	accountId: string;
	environment: Environment;
	credential: Credential;
	/** Injected in tests. */
	fetch?: Fetch;
	/** Injected clock. */
	now?: () => number;
}): BinanceAdapter {
	const now = opts.now ?? Date.now;
	const http = createBinanceHttp({
		environment: opts.environment,
		credential: opts.credential,
		now,
		...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
	});
	return {
		venue: "binance",
		capabilities: CAPABILITIES,
		verifyCredential: () => verifyCredential(http, opts.environment),
		loadInstruments: (kinds) => loadInstruments(http, kinds),
		fetchSnapshot: () => fetchSnapshot(http, opts.accountId, now),
	};
}
