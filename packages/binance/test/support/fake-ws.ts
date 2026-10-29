import type { WebSocketCtor } from "@tradedeck/adapter";

const OPEN = 1;
const CLOSED = 3;

/**
 * An in-memory client socket with the members the reconnecting socket uses.
 * The test drives the peer side with `open`, `message` and `drop`.
 */
export class FakeSocket {
	readyState = 0;
	/** Every frame the client sent, in order. */
	readonly sent: string[] = [];
	/** A silent peer never answers a ping. */
	silent = false;
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: unknown = null;
	readonly #listeners = new Map<string, Array<() => void>>();

	constructor(readonly url: string) {}

	addEventListener(type: string, fn: () => void): void {
		this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
	}

	send(data: string): void {
		if (this.readyState !== OPEN)
			throw new Error("fake ws: send while not open");
		this.sent.push(data);
	}

	/** Answered synchronously, so a manual clock can jump hours without a heartbeat timeout. */
	ping(): void {
		if (this.silent) return;
		for (const fn of this.#listeners.get("pong") ?? []) fn();
	}

	close(): void {
		this.#end(1000);
	}

	terminate(): void {
		this.#end(1006);
	}

	/** Peer: accepts the connection. */
	open(): void {
		this.readyState = OPEN;
		this.onopen?.({});
	}

	/** Peer: sends a text frame; objects are JSON-encoded. */
	message(frame: unknown): void {
		const data = typeof frame === "string" ? frame : JSON.stringify(frame);
		this.onmessage?.({ data });
	}

	/** Peer: the connection is gone. */
	drop(code = 1006): void {
		if (this.readyState === CLOSED) return;
		this.readyState = CLOSED;
		this.onclose?.({ code, reason: "" });
	}

	/** The sent frames, parsed. */
	frames(): unknown[] {
		return this.sent.map((s) => JSON.parse(s) as unknown);
	}

	#end(code: number): void {
		if (this.readyState === CLOSED) return;
		this.readyState = CLOSED;
		queueMicrotask(() => this.onclose?.({ code, reason: "" }));
	}
}

export interface FakeWebSockets {
	/** Inject as the `WebSocket` option. */
	WebSocket: WebSocketCtor;
	/** Every socket constructed, in order. */
	all: FakeSocket[];
	/** The newest socket whose URL starts with `prefix`; throws when none. */
	latest(prefix: string): FakeSocket;
	/** How many sockets were constructed with a URL starting with `prefix`. */
	count(prefix: string): number;
}

export function fakeWebSockets(): FakeWebSockets {
	const all: FakeSocket[] = [];
	class Tracked extends FakeSocket {
		constructor(url: string) {
			super(url);
			all.push(this);
		}
	}
	const matching = (prefix: string) =>
		all.filter((s) => s.url.startsWith(prefix));
	return {
		WebSocket: Tracked as unknown as WebSocketCtor,
		all,
		latest(prefix) {
			const socket = matching(prefix).at(-1);
			if (socket === undefined) throw new Error(`fake ws: no ${prefix} socket`);
			return socket;
		},
		count: (prefix) => matching(prefix).length,
	};
}
