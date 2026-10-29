import type { Params } from "@tradedeck/adapter";

/**
 * The payload a spot WS API SIGNED request signs: every param except
 * `signature`, sorted by name, as `name=value` joined by `&`, without
 * percent-encoding (binance-spot-api-docs, web-socket-api.md, "SIGNED request
 * security"). The signer encodes it as UTF-8.
 */
export function wsApiPayload(params: Params): string {
	return Object.keys(params)
		.filter((k) => k !== "signature")
		.sort()
		.map((k) => `${k}=${String(params[k])}`)
		.join("&");
}
