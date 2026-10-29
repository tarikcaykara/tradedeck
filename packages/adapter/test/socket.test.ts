import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import {
	createReconnectingSocket,
	type ReconnectingSocket,
	type SocketStatus,
	type WebSocketCtor,
} from "../src/socket.ts";

let server: Server<undefined> | undefined;
let socket: ReconnectingSocket | undefined;

afterEach(() => {
	socket?.close();
	socket = undefined;
	server?.stop(true);
	server = undefined;
});

/** Local fake venue. `onOpen` receives the 1-based connection number. */
function serve(handlers: {
	onOpen?: (ws: ServerWebSocket<undefined>, n: number) => void;
	onMessage?: (data: string) => void;
}): { url: string; connections: () => number } {
	let connections = 0;
	server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			return srv.upgrade(req)
				? undefined
				: new Response("upgrade required", { status: 426 });
		},
		websocket: {
			open(ws) {
				connections++;
				handlers.onOpen?.(ws, connections);
			},
			message(_, data) {
				handlers.onMessage?.(String(data));
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		connections: () => connections,
	};
}

/** Records statuses; `until` resolves once the list satisfies a predicate. */
function statusLog() {
	const statuses: SocketStatus[] = [];
	const waiters: Array<{ done: () => boolean; resolve: () => void }> = [];
	return {
		statuses,
		onStatus(s: SocketStatus) {
			statuses.push(s);
			for (const w of [...waiters]) {
				if (w.done()) {
					waiters.splice(waiters.indexOf(w), 1);
					w.resolve();
				}
			}
		},
		count(state: SocketStatus["state"]) {
			return statuses.filter((s) => s.state === state).length;
		},
		until(done: () => boolean): Promise<void> {
			if (done()) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ done, resolve });
			return promise;
		},
		retries() {
			return statuses.flatMap((s) =>
				s.state === "closed" ? [s.retryInMs] : [],
			);
		},
	};
}

describe("createReconnectingSocket", () => {
	test("reconnects after every server-side close with growing backoff", async () => {
		const fake = serve({ onOpen: (ws) => ws.close(4000, "go away") });
		const log = statusLog();
		socket = createReconnectingSocket({
			url: () => fake.url,
			onMessage: () => {},
			onStatus: log.onStatus,
			random: () => 0,
			initialDelayMs: 4,
			maxDelayMs: 1000,
		});
		await log.until(() => log.count("closed") >= 4);
		expect(log.retries().slice(0, 4)).toEqual([2, 4, 8, 16]);
		expect(fake.connections()).toBeGreaterThanOrEqual(4);
		expect(log.statuses.slice(0, 4)).toEqual([
			{ state: "connecting", attempt: 1 },
			{ state: "open" },
			{ state: "closed", code: 4000, reason: "go away", retryInMs: 2 },
			{ state: "connecting", attempt: 2 },
		]);
	});

	test("caps the delay at maxDelayMs, with jitter in its upper half", async () => {
		const fake = serve({ onOpen: (ws) => ws.close() });
		const log = statusLog();
		socket = createReconnectingSocket({
			url: () => fake.url,
			onMessage: () => {},
			onStatus: log.onStatus,
			random: () => 0.5,
			initialDelayMs: 4,
			maxDelayMs: 8,
		});
		await log.until(() => log.count("closed") >= 4);
		expect(log.retries().slice(0, 4)).toEqual([3, 6, 6, 6]);
	});

	test("forwards text frames and drops binary ones", async () => {
		const fake = serve({
			onOpen: (ws) => {
				ws.send(new Uint8Array([1, 2, 3]));
				ws.send("hello");
			},
		});
		const received: string[] = [];
		const { promise, resolve } = Promise.withResolvers<void>();
		socket = createReconnectingSocket({
			url: () => fake.url,
			onMessage: (data) => {
				received.push(data);
				resolve();
			},
		});
		await promise;
		expect(received).toEqual(["hello"]);
	});

	test("resets the backoff after a connection stayed open for stableAfterMs", async () => {
		let t = 0;
		let held: ServerWebSocket<undefined> | undefined;
		const fake = serve({
			onOpen: (ws, n) => {
				if (n < 3) ws.close();
				else held = ws;
			},
		});
		const log = statusLog();
		socket = createReconnectingSocket({
			url: () => fake.url,
			onMessage: () => {},
			onStatus: log.onStatus,
			now: () => t,
			random: () => 0,
			initialDelayMs: 4,
			stableAfterMs: 1000,
		});
		await log.until(() => log.count("open") === 3);
		t += 1000;
		held?.close();
		await log.until(() => log.count("closed") === 3);
		expect(log.retries()).toEqual([2, 4, 2]);
	});

	test("a rejected url() is a failed attempt", async () => {
		const fake = serve({});
		const log = statusLog();
		let calls = 0;
		socket = createReconnectingSocket({
			url: async () => {
				calls++;
				if (calls <= 2) throw new Error("listen key request failed");
				return fake.url;
			},
			onMessage: () => {},
			onStatus: log.onStatus,
			random: () => 0,
			initialDelayMs: 4,
		});
		await log.until(() => log.count("open") === 1);
		expect(log.statuses).toEqual([
			{ state: "connecting", attempt: 1 },
			{
				state: "closed",
				code: null,
				reason: "listen key request failed",
				retryInMs: 2,
			},
			{ state: "connecting", attempt: 2 },
			{
				state: "closed",
				code: null,
				reason: "listen key request failed",
				retryInMs: 4,
			},
			{ state: "connecting", attempt: 3 },
			{ state: "open" },
		]);
	});

	test("a throwing WebSocket constructor schedules a retry", async () => {
		class Throwing {
			constructor() {
				throw new Error("bad url");
			}
		}
		const log = statusLog();
		socket = createReconnectingSocket({
			url: () => "ws://127.0.0.1:1",
			onMessage: () => {},
			onStatus: log.onStatus,
			WebSocket: Throwing as unknown as WebSocketCtor,
			random: () => 0,
			initialDelayMs: 4,
		});
		await log.until(() => log.count("closed") === 2);
		expect(log.statuses[1]).toEqual({
			state: "closed",
			code: null,
			reason: "bad url",
			retryInMs: 2,
		});
	});

	test("close() cancels the pending retry for good", async () => {
		const fake = serve({ onOpen: (ws) => ws.close() });
		const log = statusLog();
		socket = createReconnectingSocket({
			url: () => fake.url,
			onMessage: () => {},
			onStatus: log.onStatus,
			random: () => 0,
			initialDelayMs: 100,
		});
		await log.until(() => log.count("closed") === 1);
		socket.close();
		const seen = log.statuses.length;
		// Real wait: the assertion is that a real timer never fires.
		await Bun.sleep(5 * 50);
		expect(fake.connections()).toBe(1);
		expect(log.statuses).toHaveLength(seen);
	});

	test("send() works only while the socket is open", async () => {
		const { promise: got, resolve } = Promise.withResolvers<string>();
		const fake = serve({ onMessage: resolve });
		const log = statusLog();
		socket = createReconnectingSocket({
			url: () => fake.url,
			onMessage: () => {},
			onStatus: log.onStatus,
		});
		expect(socket.send("early")).toBe(false);
		await log.until(() => log.count("open") === 1);
		expect(socket.send("x")).toBe(true);
		expect(await got).toBe("x");
	});

	test("a healthy peer survives the heartbeat", async () => {
		const fake = serve({});
		const log = statusLog();
		socket = createReconnectingSocket({
			url: () => fake.url,
			onMessage: () => {},
			onStatus: log.onStatus,
			heartbeatMs: 100,
		});
		await log.until(() => log.count("open") === 1);
		// Real wait: six intervals of real pings answered by a real server.
		await Bun.sleep(600);
		expect(fake.connections()).toBe(1);
		expect(log.count("closed")).toBe(0);
	});

	test("a silent peer is terminated and reconnected", async () => {
		// Opens, then never answers a ping.
		class Silent {
			readyState = 0;
			onopen: (() => void) | null = null;
			onclose: ((e: { code: number; reason: string }) => void) | null = null;
			constructor() {
				// After the socket has assigned its handlers.
				queueMicrotask(() => {
					this.readyState = 1;
					this.onopen?.();
				});
			}
			addEventListener() {}
			ping() {}
			terminate() {
				this.readyState = 3;
				queueMicrotask(() => this.onclose?.({ code: 1006, reason: "" }));
			}
			close() {
				this.readyState = 3;
			}
		}
		const log = statusLog();
		socket = createReconnectingSocket({
			url: () => "ws://127.0.0.1:1",
			onMessage: () => {},
			onStatus: log.onStatus,
			WebSocket: Silent as unknown as WebSocketCtor,
			random: () => 0,
			initialDelayMs: 4,
			heartbeatMs: 20,
		});
		await log.until(() => log.count("connecting") === 2);
		expect(log.statuses.slice(0, 4)).toEqual([
			{ state: "connecting", attempt: 1 },
			{ state: "open" },
			{
				state: "closed",
				code: 1006,
				reason: "heartbeat timeout",
				retryInMs: 2,
			},
			{ state: "connecting", attempt: 2 },
		]);
	});

	test("reconnect() drops the open connection and connects again", async () => {
		const fake = serve({});
		const log = statusLog();
		let urls = 0;
		socket = createReconnectingSocket({
			url: () => {
				urls++;
				return fake.url;
			},
			onMessage: () => {},
			onStatus: log.onStatus,
			random: () => 0,
			initialDelayMs: 4,
		});
		await log.until(() => log.count("open") === 1);
		socket.reconnect();
		await log.until(() => log.count("open") === 2);
		expect(fake.connections()).toBe(2);
		expect(urls).toBe(2);
		expect(log.statuses[2]).toMatchObject({
			state: "closed",
			reason: "reconnect",
		});
	});
});
