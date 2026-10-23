export type SocketStatus =
	/** `attempt` counts from 1 and resets only after a stable connection. */
	| { state: "connecting"; attempt: number }
	| { state: "open" }
	/** `code` is null when no socket was opened (URL or constructor failed). */
	| { state: "closed"; code: number | null; reason: string; retryInMs: number };

export interface ReconnectingSocket {
	/** False unless the socket is open; nothing is queued. */
	send(data: string): boolean;
	/** Final: cancels any pending retry and never reconnects. */
	close(): void;
}

/** The part of the `WebSocket` constructor the socket uses; the global satisfies it. */
export type WebSocketCtor = new (url: string) => WebSocket;

const OPEN = 1; // WebSocket.OPEN

/**
 * A WebSocket that reconnects forever with exponential backoff and equal
 * jitter. The backoff resets only after a connection stayed open for
 * `stableAfterMs`, not on the first message: a private stream may be silent
 * for a long time, and detecting a silently dead stream is the caller's job.
 * Connecting starts immediately.
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
	/** Default `Math.random`. */
	random?: () => number;
	/** Default 1 s. */
	initialDelayMs?: number;
	/** Default 30 s. */
	maxDelayMs?: number;
	/** Default 30 s. */
	stableAfterMs?: number;
}): ReconnectingSocket {
	const Ctor = opts.WebSocket ?? globalThis.WebSocket;
	const now = opts.now ?? Date.now;
	const random = opts.random ?? Math.random;
	const initialDelayMs = opts.initialDelayMs ?? 1000;
	const maxDelayMs = opts.maxDelayMs ?? 30_000;
	const stableAfterMs = opts.stableAfterMs ?? 30_000;
	const { onMessage, onStatus } = opts;

	let socket: WebSocket | undefined;
	let timer: Timer | undefined;
	let attempt = 0;
	let openedAt: number | null = null;
	let closed = false;

	async function connect(): Promise<void> {
		if (closed) return;
		onStatus?.({ state: "connecting", attempt: attempt + 1 });
		let ws: WebSocket;
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
		ws.onopen = () => {
			openedAt = now();
			onStatus?.({ state: "open" });
		};
		ws.onmessage = (event: MessageEvent) => {
			if (typeof event.data === "string") onMessage(event.data);
		};
		// No onerror reconnect: an error is always followed by a close event,
		// and the reconnect is armed there only, so it cannot be armed twice.
		ws.onclose = (event: CloseEvent) => {
			socket = undefined;
			if (closed) return;
			if (openedAt !== null && now() - openedAt >= stableAfterMs) attempt = 0;
			openedAt = null;
			scheduleReconnect(event.code, event.reason);
		};
	}

	function scheduleReconnect(code: number | null, reason: string): void {
		if (closed || timer !== undefined) return;
		const cap = Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);
		const retryInMs = Math.round(cap / 2 + (random() * cap) / 2);
		attempt++;
		onStatus?.({ state: "closed", code, reason, retryInMs });
		timer = setTimeout(() => {
			timer = undefined;
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
		close() {
			// Flag first: the close handler must not re-arm the timer cancelled here.
			closed = true;
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			socket?.close();
			socket = undefined;
		},
	};
}
