import {
	createReconnectingSocket,
	type ReconnectingSocket,
	type SocketStatus,
	type Timers,
	VenueError,
	type WebSocketCtor,
} from "@tradedeck/adapter";
import type { Environment } from "@tradedeck/core";
import { z } from "zod";
import { ENDPOINTS } from "./endpoints.ts";
import { BINANCE_STREAM_URLS } from "./env.ts";
import type { BinanceHttp } from "./http.ts";

/**
 * Callbacks of one user-data stream. `onUp` and `onDown` alternate, except
 * that `onDown` also follows every failed connect attempt.
 */
export interface UserStreamListener {
	/** A venue event, undecoded: the inner `event` on spot, the frame on futures. */
	onEvent(event: unknown): void;
	/** The stream delivers events from now on. */
	onUp(): void;
	/** The connection is gone or never came up; the stream is reconnecting. */
	onDown(): void;
	/** A failure the stream recovers from; never carries credentials. */
	onError(err: Error): void;
}

export interface UserStream {
	/** Final: clears every timer; no listener call follows. */
	close(): void;
}

export interface UserStreamDeps {
	environment: Environment;
	http: BinanceHttp;
	now: () => number;
	timers: Timers;
	/** Default `globalThis.WebSocket`. */
	WebSocket?: WebSocketCtor;
}

const SUBSCRIBE_TIMEOUT_MS = 10_000;
const LISTEN_KEY_KEEPALIVE_MS = 30 * 60_000;
/** Both venues end a connection at 24 h; rotating earlier makes it a planned resync. */
const MAX_CONNECTION_MS = 23 * 60 * 60_000;
/** Binance: "This listenKey does not exist." */
const LISTEN_KEY_MISSING = "-1125";
/** Binance: "Timestamp for this request is outside of the recvWindow." */
const TIMESTAMP_OUTSIDE_RECV_WINDOW = "-1021";
const SPOT_SUBSCRIBE = "userDataStream.subscribe.signature";

const ListenKey = z.object({ listenKey: z.string().min(1) });
const KeepAlive = z.object({});
/** A WS API response (`id`) or a pushed event (`event`); other frames are ignored. */
const SpotFrame = z.looseObject({
	id: z.unknown().optional(),
	status: z.unknown().optional(),
	error: z.unknown().optional(),
	event: z.unknown().optional(),
});
const SpotEvent = z.looseObject({ e: z.string() });
const WsApiError = z
	.object({ code: z.union([z.number(), z.string()]), msg: z.string() })
	.partial();
const FuturesFrame = z.looseObject({ e: z.string() });

const asError = (err: unknown): Error =>
	err instanceof Error ? err : new Error(String(err));

function notJson(stream: "spot" | "futures"): VenueError {
	return new VenueError({
		kind: "decode",
		method: "WS",
		path: `${stream} user stream`,
		status: null,
		code: null,
		retryAfterMs: null,
		text: "frame is not JSON",
	});
}

/** `undefined` when the frame is not JSON, `null` when it does not match `schema`. */
function parseFrame<T>(
	schema: z.ZodType<T>,
	data: string,
): T | null | undefined {
	let json: unknown;
	try {
		json = JSON.parse(data);
	} catch {
		return undefined;
	}
	return schema.safeParse(json).data ?? null;
}

/**
 * Spot: one WS API connection subscribed with
 * `userDataStream.subscribe.signature`. Up once the subscription is accepted;
 * a refused or unanswered subscription, `serverShutdown` and
 * `eventStreamTerminated` reconnect.
 */
export function openSpotUserStream(
	deps: UserStreamDeps,
	listener: UserStreamListener,
): UserStream {
	const { timers } = deps;
	let closed = false;
	let requests = 0;
	// The id of the subscription awaiting its answer; cleared on close, so a
	// signature that resolves after the connection dropped is never sent.
	let pending: string | null = null;
	let subscribed = false;
	let subscribeTimer: unknown = null;
	let rotateTimer: unknown = null;

	function clearTimers(): void {
		for (const t of [subscribeTimer, rotateTimer]) {
			if (t !== null) timers.clearTimeout(t);
		}
		subscribeTimer = null;
		rotateTimer = null;
	}

	async function subscribe(): Promise<void> {
		const id = `subscribe-${++requests}`;
		pending = id;
		let params: Record<string, string | number | boolean>;
		try {
			params = await deps.http.signWsApi({});
		} catch (err) {
			if (closed) return;
			listener.onError(asError(err));
			if (pending === id) {
				pending = null;
				socket.reconnect();
			}
			return;
		}
		if (closed || pending !== id) return;
		socket.send(JSON.stringify({ id, method: SPOT_SUBSCRIBE, params }));
		subscribeTimer = timers.setTimeout(() => {
			subscribeTimer = null;
			if (pending !== id) return;
			pending = null;
			listener.onError(
				new VenueError({
					kind: "timeout",
					method: "WS",
					path: SPOT_SUBSCRIBE,
					status: null,
					code: null,
					retryAfterMs: null,
					text: `no response within ${SUBSCRIBE_TIMEOUT_MS} ms`,
				}),
			);
			socket.reconnect();
		}, SUBSCRIBE_TIMEOUT_MS);
	}

	function answered(status: unknown, error: unknown): void {
		pending = null;
		if (subscribeTimer !== null) {
			timers.clearTimeout(subscribeTimer);
			subscribeTimer = null;
		}
		if (status === 200) {
			subscribed = true;
			rotateTimer = timers.setTimeout(() => {
				rotateTimer = null;
				socket.reconnect();
			}, MAX_CONNECTION_MS);
			listener.onUp();
			return;
		}
		const venue = WsApiError.safeParse(error).data;
		const code = venue?.code === undefined ? null : String(venue.code);
		listener.onError(
			new VenueError({
				kind: "http",
				method: "WS",
				path: SPOT_SUBSCRIBE,
				status: typeof status === "number" ? status : null,
				code,
				retryAfterMs: null,
				text: venue?.msg ?? "subscription refused",
			}),
		);
		if (code === TIMESTAMP_OUTSIDE_RECV_WINDOW) {
			deps.http.invalidateClock("spot");
		}
		socket.reconnect();
	}

	function onMessage(data: string): void {
		if (closed) return;
		const frame = parseFrame(SpotFrame, data);
		if (frame === undefined) {
			listener.onError(notJson("spot"));
			socket.reconnect();
			return;
		}
		if (frame === null) return;
		if (frame.id !== undefined) {
			if (pending !== null && frame.id === pending) {
				answered(frame.status, frame.error);
			}
			return;
		}
		const event = SpotEvent.safeParse(frame.event).data;
		if (event === undefined) return;
		if (event.e === "serverShutdown" || event.e === "eventStreamTerminated") {
			socket.reconnect();
			return;
		}
		if (subscribed) listener.onEvent(event);
	}

	function onStatus(s: SocketStatus): void {
		if (closed) return;
		if (s.state === "open") {
			void subscribe();
		} else if (s.state === "closed") {
			clearTimers();
			pending = null;
			subscribed = false;
			listener.onDown();
		}
	}

	const socket: ReconnectingSocket = createReconnectingSocket({
		url: () => BINANCE_STREAM_URLS[deps.environment].spotWsApi,
		onMessage,
		onStatus,
		now: deps.now,
		timers,
		...(deps.WebSocket === undefined ? {} : { WebSocket: deps.WebSocket }),
	});

	return {
		close() {
			closed = true;
			clearTimers();
			pending = null;
			socket.close();
		},
	};
}

/**
 * USDⓈ-M futures: a listen key from `POST /fapi/v1/listenKey`, kept alive
 * with `PUT` every 30 min, on the private stream path. A key is requested
 * again before every connect. `DELETE` is never sent: `POST` returns the
 * account's single active key, so deleting it would end every other
 * connection on it; an unkept key lapses after 60 min.
 */
export function openFuturesUserStream(
	deps: UserStreamDeps,
	listener: UserStreamListener,
): UserStream {
	const { timers, http } = deps;
	let closed = false;
	let open = false;
	// Bumped on every open: a keepalive started on an earlier connection
	// never re-arms or reconnects the current one.
	let connection = 0;
	let keepaliveTimer: unknown = null;
	let rotateTimer: unknown = null;

	function clearTimers(): void {
		for (const t of [keepaliveTimer, rotateTimer]) {
			if (t !== null) timers.clearTimeout(t);
		}
		keepaliveTimer = null;
		rotateTimer = null;
	}

	const current = (c: number) => !closed && open && c === connection;

	function armKeepalive(c: number): void {
		keepaliveTimer = timers.setTimeout(() => {
			keepaliveTimer = null;
			void keepalive(c);
		}, LISTEN_KEY_KEEPALIVE_MS);
	}

	async function keepalive(c: number): Promise<void> {
		try {
			await http.request(ENDPOINTS.listenKeyKeepalive, KeepAlive);
		} catch (err) {
			if (!current(c)) return;
			if (err instanceof VenueError && err.code === LISTEN_KEY_MISSING) {
				socket.reconnect();
				return;
			}
			listener.onError(asError(err));
		}
		if (current(c)) armKeepalive(c);
	}

	async function url(): Promise<string> {
		try {
			const { listenKey } = await http.request(ENDPOINTS.listenKey, ListenKey);
			return `${BINANCE_STREAM_URLS[deps.environment].futuresPrivate}${listenKey}`;
		} catch (err) {
			if (!closed) listener.onError(asError(err));
			throw err;
		}
	}

	function onMessage(data: string): void {
		if (closed) return;
		const frame = parseFrame(FuturesFrame, data);
		if (frame === undefined) {
			listener.onError(notJson("futures"));
			socket.reconnect();
			return;
		}
		if (frame === null) return;
		if (frame.e === "listenKeyExpired") {
			socket.reconnect();
			return;
		}
		listener.onEvent(frame);
	}

	function onStatus(s: SocketStatus): void {
		if (closed) return;
		if (s.state === "open") {
			open = true;
			const c = ++connection;
			armKeepalive(c);
			rotateTimer = timers.setTimeout(() => {
				rotateTimer = null;
				socket.reconnect();
			}, MAX_CONNECTION_MS);
			listener.onUp();
		} else if (s.state === "closed") {
			open = false;
			clearTimers();
			listener.onDown();
		}
	}

	const socket: ReconnectingSocket = createReconnectingSocket({
		url,
		onMessage,
		onStatus,
		now: deps.now,
		timers,
		...(deps.WebSocket === undefined ? {} : { WebSocket: deps.WebSocket }),
	});

	return {
		close() {
			closed = true;
			clearTimers();
			socket.close();
		},
	};
}
