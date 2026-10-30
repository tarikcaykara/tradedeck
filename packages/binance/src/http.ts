import {
	createRestClient,
	createServerClock,
	createSigner,
	type Fetch,
	type Params,
	type RestClient,
	type ServerClock,
	VenueError,
} from "@tradedeck/adapter";
import type { Credential, Environment } from "@tradedeck/core";
import { z } from "zod";
import { decode } from "./decode.ts";
import { ENDPOINTS, type Endpoint } from "./endpoints.ts";
import { API_KEY_HEADER, BINANCE_HOSTS, type Host } from "./env.ts";
import { wsApiPayload } from "./ws-api.ts";

export interface BinanceHttp {
	/** Sends one endpoint request and parses the body with `schema`. */
	request<T>(
		endpoint: Endpoint,
		schema: z.ZodType<T>,
		params?: Params,
	): Promise<T>;
	/**
	 * Spot WS API SIGNED params: `params` plus `apiKey` and `timestamp` (spot
	 * server clock), signed over `wsApiPayload`, plus `signature`.
	 */
	signWsApi(params: Params): Promise<Record<string, string | number | boolean>>;
	/** Forces the host's clock to resync before its next signed request. */
	invalidateClock(host: Host): void;
}

const ServerTime = z.object({ serverTime: z.number().int() });

/** Binance: "Timestamp for this request is outside of the recvWindow." */
const TIMESTAMP_OUTSIDE_RECV_WINDOW = "-1021";

/**
 * One REST client and one server clock per host: spot and futures are
 * separate servers with separate clock offsets.
 */
export function createBinanceHttp(opts: {
	environment: Environment;
	credential: Credential;
	fetch?: Fetch;
	now?: () => number;
}): BinanceHttp {
	const signer = createSigner(opts.credential);
	const now = opts.now ?? Date.now;
	const hosts = BINANCE_HOSTS[opts.environment];

	function connect(
		host: Host,
		time: Endpoint,
	): { client: RestClient; clock: ServerClock } {
		const clock = createServerClock({
			now,
			fetchServerTime: async () =>
				decode(ServerTime, await client.request(time), time).serverTime,
		});
		const client = createRestClient({
			baseUrl: hosts[host],
			signer,
			apiKeyHeader: API_KEY_HEADER,
			clock,
			...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
		});
		return { client, clock };
	}

	const byHost: Record<Host, { client: RestClient; clock: ServerClock }> = {
		spot: connect("spot", ENDPOINTS.spotTime),
		futures: connect("futures", ENDPOINTS.futuresTime),
	};

	return {
		async request(endpoint, schema, params) {
			const { client, clock } = byHost[endpoint.host];
			const request = {
				method: endpoint.method,
				path: endpoint.path,
				params: { ...endpoint.params, ...params },
				auth: endpoint.auth,
			};
			let body: unknown;
			try {
				body = await client.request(request);
			} catch (err) {
				// A stale offset is a definite rejection before processing, and
				// every signed M1 call is a read: resync and retry exactly once.
				if (
					!(err instanceof VenueError) ||
					err.code !== TIMESTAMP_OUTSIDE_RECV_WINDOW ||
					endpoint.auth !== "signed"
				) {
					throw err;
				}
				clock.invalidate();
				body = await client.request(request);
			}
			return decode(schema, body, endpoint);
		},
		async signWsApi(params) {
			const all = {
				...params,
				apiKey: signer.apiKey,
				timestamp: await byHost.spot.clock.timestamp(),
			};
			return { ...all, signature: signer.sign(wsApiPayload(all)) };
		},
		invalidateClock(host) {
			byHost[host].clock.invalidate();
		},
	};
}
