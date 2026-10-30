import type { Environment } from "@tradedeck/core";

export type Host = "spot" | "futures";

/** REST base URLs per environment (docs/venues/binance.md, Environments). */
export const BINANCE_HOSTS: Readonly<
	Record<Environment, Readonly<Record<Host, string>>>
> = {
	live: {
		spot: "https://api.binance.com",
		futures: "https://fapi.binance.com",
	},
	demo: {
		spot: "https://demo-api.binance.com",
		futures: "https://demo-fapi.binance.com",
	},
};

export const API_KEY_HEADER = "X-MBX-APIKEY";

/**
 * User-data stream endpoints per environment (docs/venues/binance.md,
 * Private streams): the spot WS API, and the futures private-stream prefix
 * the listen key is appended to.
 */
export const BINANCE_STREAM_URLS: Readonly<
	Record<Environment, { spotWsApi: string; futuresPrivate: string }>
> = {
	live: {
		spotWsApi: "wss://ws-api.binance.com:443/ws-api/v3",
		futuresPrivate: "wss://fstream.binance.com/private/ws/",
	},
	demo: {
		spotWsApi: "wss://demo-ws-api.binance.com/ws-api/v3",
		futuresPrivate: "wss://demo-fstream.binance.com/private/ws/",
	},
};
