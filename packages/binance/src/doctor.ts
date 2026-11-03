/**
 * Readings for `doctor` (docs/architecture.md §9): the local clock against
 * each host, and whether a private stream comes up. They judge nothing about
 * permissions; the CLI does.
 */
import { DEFAULT_RECV_WINDOW_MS } from "@tradedeck/adapter";
import { ENDPOINTS } from "./endpoints.ts";
import type { Host } from "./env.ts";
import { type BinanceHttp, ServerTime } from "./http.ts";
import {
	openFuturesUserStream,
	openSpotUserStream,
	type UserStreamDeps,
} from "./user-streams.ts";

/** Binance rejects a timestamp this far ahead of its own clock, or further. */
const MAX_AHEAD_MS = 1000;

/**
 * Server time minus local time in ms, from the host's public time endpoint:
 * the server read its clock somewhere in the request window, so the local
 * midpoint is taken, as the adapter's server clock does.
 */
export async function measureClockOffset(
	http: BinanceHttp,
	host: Host,
	now: () => number,
): Promise<number> {
	const endpoint = host === "spot" ? ENDPOINTS.spotTime : ENDPOINTS.futuresTime;
	const t0 = now();
	const { serverTime } = await http.request(endpoint, ServerTime);
	const t1 = now();
	return Math.round(serverTime - (t0 + t1) / 2);
}

/**
 * Whether a request stamped with the local clock alone would be accepted:
 * Binance requires `timestamp < serverTime + 1000` and
 * `serverTime − timestamp ≤ recvWindow`. The adapter stamps with its server
 * clock instead, so outside this window every signed request depends on that
 * clock's resync.
 */
export function withinRecvWindow(offsetMs: number): boolean {
	return offsetMs > -MAX_AHEAD_MS && offsetMs <= DEFAULT_RECV_WINDOW_MS;
}

/**
 * Opens one private user-data stream and resolves once it is up. Rejects with
 * the stream's last error when its first attempt fails, or when it is not up
 * within `timeoutMs`. The stream is closed either way; the futures listen key
 * is neither kept alive nor deleted, so it lapses on its own.
 */
export function probeUserStream(
	kind: "spot" | "futures",
	deps: UserStreamDeps,
	timeoutMs: number,
): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let lastError: Error | null = null;
	const open = kind === "spot" ? openSpotUserStream : openFuturesUserStream;
	const stream = open(deps, {
		onEvent() {},
		onUp: resolve,
		onDown: () =>
			reject(lastError ?? new Error("the connection closed before it was up")),
		onError: (err) => {
			lastError = err;
		},
	});
	const timer = deps.timers.setTimeout(
		() => reject(new Error(`not up within ${timeoutMs / 1000} s`)),
		timeoutMs,
	);
	return promise.finally(() => {
		deps.timers.clearTimeout(timer);
		stream.close();
	});
}
