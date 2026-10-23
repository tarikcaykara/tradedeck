import type { ServerClock } from "./clock.ts";
import { VenueError } from "./errors.ts";
import type { Signer } from "./signer.ts";

/**
 * - `none`: public endpoint.
 * - `apiKey`: API-key header only.
 * - `signed`: API-key header plus `recvWindow`, `timestamp` and `signature`.
 */
export type Auth = "none" | "apiKey" | "signed";
export type Params = Readonly<Record<string, string | number | boolean>>;
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** The part of `fetch` the transport uses; `globalThis.fetch` satisfies it. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RestRequest {
	method: HttpMethod;
	/** Bare path, e.g. `/api/v3/account`; parameters go in `params`. */
	path: string;
	params?: Params;
	auth: Auth;
}

/**
 * Sends one request and returns the parsed JSON body as `unknown`; schema
 * validation belongs to the venue package. Failures reject with a
 * `VenueError`. Nothing is ever retried here: the caller decides.
 */
export interface RestClient {
	request(req: RestRequest): Promise<unknown>;
}

/**
 * Query-signed scheme (Binance style): every parameter travels in the query
 * string, there is no body, and the signature covers the query exactly as
 * transmitted.
 */
export function createRestClient(opts: {
	baseUrl: string;
	/** Default: `globalThis.fetch`, captured once here. */
	fetch?: Fetch;
	/** Required for `apiKey` and `signed` requests. */
	signer?: Signer;
	/** Required with `signer`, e.g. Binance's `X-MBX-APIKEY`. */
	apiKeyHeader?: string;
	/** Required for `signed` requests. */
	clock?: ServerClock;
	/** Default 5000 ms. */
	recvWindow?: number;
	/** Default 10 s. */
	timeoutMs?: number;
}): RestClient {
	const fetchImpl = opts.fetch ?? globalThis.fetch;
	const { baseUrl, signer, apiKeyHeader, clock } = opts;
	const recvWindow = opts.recvWindow ?? 5000;
	const timeoutMs = opts.timeoutMs ?? 10_000;

	async function build(
		req: RestRequest,
	): Promise<{ query: string; headers: Record<string, string> }> {
		const pairs = Object.entries(req.params ?? {}).map(
			([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
		);
		if (req.auth === "none") return { query: pairs.join("&"), headers: {} };
		if (req.auth === "apiKey") {
			if (signer === undefined || apiKeyHeader === undefined) {
				throw new Error("rest: apiKey request needs signer and apiKeyHeader");
			}
			return {
				query: pairs.join("&"),
				headers: { [apiKeyHeader]: signer.apiKey },
			};
		}
		if (
			signer === undefined ||
			apiKeyHeader === undefined ||
			clock === undefined
		) {
			throw new Error(
				"rest: signed request needs signer, apiKeyHeader and clock",
			);
		}
		pairs.push(
			`recvWindow=${recvWindow}`,
			`timestamp=${await clock.timestamp()}`,
		);
		const query = pairs.join("&");
		const signature = encodeURIComponent(signer.sign(query));
		return {
			query: `${query}&signature=${signature}`,
			headers: { [apiKeyHeader]: signer.apiKey },
		};
	}

	return {
		async request(req) {
			const { query, headers } = await build(req);
			const url = `${baseUrl}${req.path}${query === "" ? "" : `?${query}`}`;
			const fail = (
				kind: VenueError["kind"],
				text: string,
				extra?: {
					status: number;
					code: string | null;
					retryAfterMs: number | null;
				},
			) =>
				new VenueError({
					kind,
					method: req.method,
					path: req.path,
					status: extra?.status ?? null,
					code: extra?.code ?? null,
					retryAfterMs: extra?.retryAfterMs ?? null,
					text,
				});

			// The timeout covers the response body as well as the headers.
			const signal = AbortSignal.timeout(timeoutMs);
			let res: Response;
			let body: string;
			try {
				res = await fetchImpl(url, { method: req.method, headers, signal });
				body = await res.text();
			} catch (err) {
				// The cause is not attached: Bun's fetch errors carry the full URL,
				// signature included, in a `path` property.
				if (signal.aborted) {
					throw fail("timeout", `no response within ${timeoutMs} ms`);
				}
				throw fail(
					"network",
					err instanceof Error ? err.message : "fetch failed",
				);
			}

			if (!res.ok) {
				const venue = venueError(body);
				throw fail(
					"http",
					venue.msg ?? (res.statusText || "error body is not a venue error"),
					{
						status: res.status,
						code: venue.code,
						retryAfterMs: retryAfterMs(res),
					},
				);
			}
			try {
				return JSON.parse(body) as unknown;
			} catch {
				throw fail("decode", "response body is not JSON");
			}
		},
	};
}

/** `{ "code": -1121, "msg": "Invalid symbol." }`; `message` is accepted for `msg`. */
function venueError(body: string): { code: string | null; msg: string | null } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { code: null, msg: null };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { code: null, msg: null };
	}
	const { code, msg, message } = parsed as Record<string, unknown>;
	return {
		code:
			typeof code === "number" || typeof code === "string"
				? String(code)
				: null,
		msg:
			typeof msg === "string"
				? msg
				: typeof message === "string"
					? message
					: null,
	};
}

/** Binance sends `Retry-After` in seconds with 429 (rate limit) and 418 (IP ban). */
function retryAfterMs(res: Response): number | null {
	if (res.status !== 429 && res.status !== 418) return null;
	const header = res.headers.get("Retry-After")?.trim();
	if (header === undefined || header === "") return null;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
