import { systemTimers, type Timers } from "./clock.ts";

export type SocketStatus =
	/** `attempt` counts from 1 and resets only after a stable connection. */
	| { state: "connecting"; attempt: number }
	| { state: "open" }
	/**
	 * `code` is null when no socket was opened (URL or constructor failed).
	 * `reason` is `"heartbeat timeout"` or `"reconnect"` when the socket
	 * dropped the connection itself, else the close frame's reason.
	 */
	| { state: "closed"; code: number | null; reason: string; retryInMs: number };

export interface ReconnectingSocket {
	/** False unless the socket is open; nothing is queued. */
	send(data: string): boolean;
	/**
	 * Drops the open connection; the usual backoff then connects again, so
	 * `url()` is resolved anew. Does nothing while no connection is open.
	 */
	reconnect(): void;
	/** Final: cancels any pending retry and never reconnects. */
	close(): void;
}

/**
 * The client socket the transport drives: the Web API plus the `ping()` and
 * `terminate()` that Bun's `WebSocket` has and the DOM typings lack.
 */
export type ClientWebSocket = WebSocket & {
	ping(): void;
	terminate(): void;
};

/** The part of the `WebSocket` constructor the socket uses; Bun's global satisfies it. */
export type WebSocketCtor = new (url: string) => ClientWebSocket;

const OPEN = 1; // WebSocket.OPEN

/**
 * A WebSocket that reconnects forever with exponential backoff and equal
 * jitter. The backoff resets only after a connection stayed open for
 * `stableAfterMs`, not on the first message: a private stream may be silent
 * for a long time.
 *
 * A silently dead connection is detected by a heartbeat: every `heartbeatMs`
 * while open, the socket is terminated when nothing arrived since the
 * previous tick (a message, ping or pong), else a ping is sent. A dead peer is
 * therefore dropped within two intervals. Connecting starts immediately.
 */
export function createReconnectingSocket(opts: {
	/** Resolved again before every connect, e.g. to fetch a fresh listen key. */
	url: () => string | Promise<string>;
	/** Text frames only; binary frames are dropped. */
	onMessage: (data: string) => void;
	onStatus?: (s: SocketStatus) => void;
	/** Default `globalThis.WebSocket`. */
	WebSocket?: WebSocketCtor;
	/** Default `Date.now`. */
	now?: () => number;
	/** Default `systemTimers`. */
	timers?: Timers;
	/** Default `Math.random`. */
	random?: () => number;
	/** Default 1 s. */
	initialDelayMs?: number;
	/** Default 30 s. */
	maxDelayMs?: number;
	/** Default 30 s. */
	stableAfterMs?: number;
	/** Default 15 s. */
	heartbeatMs?: number;
}): ReconnectingSocket {
	// Bun's global WebSocket has ping() and terminate(); the DOM lib types it without.
	const Ctor =
		opts.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
	const now = opts.now ?? Date.now;
	const timers = opts.timers ?? systemTimers;
	const random = opts.random ?? Math.random;
	const initialDelayMs = opts.initialDelayMs ?? 1000;
	const maxDelayMs = opts.maxDelayMs ?? 30_000;
	const stableAfterMs = opts.stableAfterMs ?? 30_000;
	const heartbeatMs = opts.heartbeatMs ?? 15_000;
	const { onMessage, onStatus } = opts;

	let socket: ClientWebSocket | undefined;
	let retryTimer: unknown = null;
	let heartbeatTimer: unknown = null;
	let attempt = 0;
	let openedAt: number | null = null;
	let closed = false;
	// Per connection: reset on every connect.
	let inbound = false;
	let terminatedFor: string | null = null;

	function stopHeartbeat(): void {
		if (heartbeatTimer !== null) {
			timers.clearTimeout(heartbeatTimer);
			heartbeatTimer = null;
		}
	}

	function terminate(ws: ClientWebSocket, reason: string): void {
		terminatedFor = reason;
		stopHeartbeat();
		ws.terminate();
	}

	function tick(ws: ClientWebSocket): void {
		heartbeatTimer = null;
		if (closed || socket !== ws || ws.readyState !== OPEN) return;
		if (!inbound) {
			terminate(ws, "heartbeat timeout");
			return;
		}
		inbound = false;
		ws.ping();
		heartbeatTimer = timers.setTimeout(() => tick(ws), heartbeatMs);
	}

	async function connect(): Promise<void> {
		if (closed) return;
		onStatus?.({ state: "connecting", attempt: attempt + 1 });
		let ws: ClientWebSocket;
		try {
			const url = await opts.url();
			if (closed) return;
			ws = new Ctor(url);
		} catch (err) {
			// A failed URL fetch or a throwing constructor is a failed attempt.
			scheduleReconnect(null, err instanceof Error ? err.message : String(err));
			return;
		}
		socket = ws;
		inbound = false;
		terminatedFor = null;
		const sawInbound = () => {
			inbound = true;
		};
		ws.addEventListener("ping", sawInbound);
		ws.addEventListener("pong", sawInbound);
		ws.onopen = () => {
			openedAt = now();
			// The open itself counts: the first tick pings, the second judges.
			inbound = true;
			heartbeatTimer = timers.setTimeout(() => tick(ws), heartbeatMs);
			onStatus?.({ state: "open" });
		};
		ws.onmessage = (event: MessageEvent) => {
			inbound = true;
			if (typeof event.data === "string") onMessage(event.data);
		};
		// No onerror reconnect: an error is always followed by a close event,
		// and the reconnect is armed there only, so it cannot be armed twice.
		ws.onclose = (event: CloseEvent) => {
			if (socket !== ws) return;
			socket = undefined;
			stopHeartbeat();
			if (closed) return;
			if (openedAt !== null && now() - openedAt >= stableAfterMs) attempt = 0;
			openedAt = null;
			scheduleReconnect(event.code, terminatedFor ?? event.reason);
		};
	}

	function scheduleReconnect(code: number | null, reason: string): void {
		if (closed || retryTimer !== null) return;
		const cap = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);
		const retryInMs = Math.round(cap / 2 + (random() * cap) / 2);
		attempt++;
		onStatus?.({ state: "closed", code, reason, retryInMs });
		retryTimer = timers.setTimeout(() => {
			retryTimer = null;
			void connect();
		}, retryInMs);
	}

	void connect();

	return {
		send(data) {
			if (socket?.readyState !== OPEN) return false;
			socket.send(data);
			return true;
		},
		reconnect() {
			if (socket?.readyState === OPEN) terminate(socket, "reconnect");
		},
		close() {
			// Flag first: the close handler must not re-arm the timer cancelled here.
			closed = true;
			if (retryTimer !== null) {
				timers.clearTimeout(retryTimer);
				retryTimer = null;
			}
			stopHeartbeat();
			socket?.close();
			socket = undefined;
		},
	};
}
