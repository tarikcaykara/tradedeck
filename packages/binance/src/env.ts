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
