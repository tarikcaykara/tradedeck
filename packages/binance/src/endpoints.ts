import type { Auth, Params } from "@tradedeck/adapter";
import type { Host } from "./env.ts";

export interface Endpoint {
	readonly host: Host;
	readonly method: "GET";
	readonly path: string;
	readonly params?: Params;
	readonly auth: Auth;
}

/**
 * Every request the adapter sends, shared with the Demo recorder so a
 * recording run exercises exactly the adapter's requests (sources:
 * docs/venues/binance.md, Endpoints).
 */
export const ENDPOINTS = {
	spotTime: { host: "spot", method: "GET", path: "/api/v3/time", auth: "none" },
	futuresTime: {
		host: "futures",
		method: "GET",
		path: "/fapi/v1/time",
		auth: "none",
	},
	apiRestrictions: {
		host: "spot",
		method: "GET",
		path: "/sapi/v1/account/apiRestrictions",
		auth: "signed",
	},
	spotExchangeInfo: {
		host: "spot",
		method: "GET",
		path: "/api/v3/exchangeInfo",
		params: { symbolStatus: "TRADING" },
		auth: "none",
	},
	futuresExchangeInfo: {
		host: "futures",
		method: "GET",
		path: "/fapi/v1/exchangeInfo",
		auth: "none",
	},
	leverageBracket: {
		host: "futures",
		method: "GET",
		path: "/fapi/v1/leverageBracket",
		auth: "signed",
	},
	spotAccount: {
		host: "spot",
		method: "GET",
		path: "/api/v3/account",
		params: { omitZeroBalances: true },
		auth: "signed",
	},
	spotOpenOrders: {
		host: "spot",
		method: "GET",
		path: "/api/v3/openOrders",
		auth: "signed",
	},
	futuresBalance: {
		host: "futures",
		method: "GET",
		path: "/fapi/v3/balance",
		auth: "signed",
	},
	positionRisk: {
		host: "futures",
		method: "GET",
		path: "/fapi/v3/positionRisk",
		auth: "signed",
	},
	symbolConfig: {
		host: "futures",
		method: "GET",
		path: "/fapi/v1/symbolConfig",
		auth: "signed",
	},
	accountConfig: {
		host: "futures",
		method: "GET",
		path: "/fapi/v1/accountConfig",
		auth: "signed",
	},
	futuresOpenOrders: {
		host: "futures",
		method: "GET",
		path: "/fapi/v1/openOrders",
		auth: "signed",
	},
	openAlgoOrders: {
		host: "futures",
		method: "GET",
		path: "/fapi/v1/openAlgoOrders",
		auth: "signed",
	},
	// Recorded for reference only: no domain field needs them.
	futuresAccount: {
		host: "futures",
		method: "GET",
		path: "/fapi/v3/account",
		auth: "signed",
	},
	positionMode: {
		host: "futures",
		method: "GET",
		path: "/fapi/v1/positionSide/dual",
		auth: "signed",
	},
} as const satisfies Record<string, Endpoint>;

export type EndpointName = keyof typeof ENDPOINTS;
