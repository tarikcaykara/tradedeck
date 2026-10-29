import { afterEach, describe, expect, test } from "bun:test";
import { type Fetch, VenueError } from "@tradedeck/adapter";
import type { Environment } from "@tradedeck/core";
import { createBinanceHttp } from "../src/http.ts";
import {
	openFuturesUserStream,
	openSpotUserStream,
	type UserStream,
} from "../src/user-streams.ts";
import { type ManualClock, manualClock } from "./support/clock.ts";
import { fakeWebSockets } from "./support/fake-ws.ts";
import { until } from "./support/wait.ts";

const SPOT = "wss://demo-ws-api.binance.com/ws-api/v3";
const FUTURES = "wss://demo-fstream.binance.com/private/ws/";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface FakeVenue {
	fetch: Fetch;
	/** `METHOD /path` per request, in order. */
	calls: string[];
	count(call: string): number;
	/** Overrides the listen-key answers while set. */
	post: (() => Response) | null;
	put: (() => Response) | null;
}

/** Time endpoints from the manual clock, listen keys `lk-<n>`. */
function fakeVenue(clock: ManualClock): FakeVenue {
	const calls: string[] = [];
	let keys = 0;
	const venue: FakeVenue = {
		calls,
		count: (call) => calls.filter((c) => c === call).length,
		post: null,
		put: null,
		fetch: async (url, init) => {
			const { pathname } = new URL(url);
			const method = init.method ?? "GET";
			calls.push(`${method} ${pathname}`);
			if (pathname === "/api/v3/time" || pathname === "/fapi/v1/time") {
				return Response.json({ serverTime: clock.now() });
			}
			if (pathname === "/fapi/v1/listenKey" && method === "POST") {
				return venue.post?.() ?? Response.json({ listenKey: `lk-${++keys}` });
			}
			if (pathname === "/fapi/v1/listenKey" && method === "PUT") {
				return venue.put?.() ?? Response.json({});
			}
			return new Response("unexpected", { status: 500 });
		},
	};
	return venue;
}

let stream: UserStream | undefined;
afterEach(() => {
	stream?.close();
	stream = undefined;
});

function setup(kind: "spot" | "futures", environment: Environment = "demo") {
	const clock = manualClock();
	const venue = fakeVenue(clock);
	const sockets = fakeWebSockets();
	const log: string[] = [];
	const errors: Error[] = [];
	const events: unknown[] = [];
	const http = createBinanceHttp({
		environment,
		credential: { kind: "hmac", apiKey: "k", secret: "s" },
		fetch: venue.fetch,
		now: clock.now,
	});
	const open = kind === "spot" ? openSpotUserStream : openFuturesUserStream;
	stream = open(
		{
			environment,
			http,
			now: clock.now,
			timers: clock.timers,
			WebSocket: sockets.WebSocket,
		},
		{
			onEvent: (e) => {
				log.push("event");
				events.push(e);
			},
			onUp: () => log.push("up"),
			onDown: () => log.push("down"),
			onError: (err) => {
				log.push("error");
				errors.push(err);
			},
		},
	);
	return { clock, venue, sockets, log, errors, events, stream };
}

type Setup = ReturnType<typeof setup>;

/** Opens the newest spot socket and returns its subscribe request once sent. */
async function openSpot(t: Setup): Promise<unknown> {
	await until(() => t.sockets.count(SPOT) > 0);
	const ws = t.sockets.latest(SPOT);
	ws.open();
	await until(() => ws.sent.length === 1);
	return ws.frames()[0];
}

async function spotUp(t: Setup): Promise<void> {
	const { id } = (await openSpot(t)) as { id: string };
	t.sockets.latest(SPOT).message({ id, status: 200, result: {} });
}

async function futuresUp(t: Setup): Promise<void> {
	await until(() => t.sockets.count(FUTURES) > 0);
	t.sockets.latest(FUTURES).open();
}

describe("openSpotUserStream", () => {
	test("subscribes with a signed request and forwards events once accepted", async () => {
		const t = setup("spot");
		const request = await openSpot(t);
		expect(request).toEqual({
			id: "subscribe-1",
			method: "userDataStream.subscribe.signature",
			params: {
				apiKey: "k",
				timestamp: t.clock.now(),
				signature: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		});
		const ws = t.sockets.latest(SPOT);
		ws.message({ id: "other", status: 200, result: {} });
		expect(t.log).toEqual([]);
		ws.message({ id: "subscribe-1", status: 200, result: {} });
		ws.message({
			subscriptionId: 0,
			event: { e: "outboundAccountPosition", E: 7 },
		});
		expect(t.log).toEqual(["up", "event"]);
		expect(t.events).toEqual([{ e: "outboundAccountPosition", E: 7 }]);
	});

	test("a -1021 refusal resyncs the spot clock and reconnects", async () => {
		const t = setup("spot");
		const { id } = (await openSpot(t)) as { id: string };
		t.sockets.latest(SPOT).message({
			id,
			status: 400,
			error: { code: -1021, msg: "Timestamp outside of the recvWindow." },
		});
		await until(() => t.log.includes("down"));
		expect(t.log).toEqual(["error", "down"]);
		expect(t.errors[0]).toBeInstanceOf(VenueError);
		expect(t.errors[0]).toMatchObject({
			kind: "http",
			method: "WS",
			path: "userDataStream.subscribe.signature",
			status: 400,
			code: "-1021",
		});
		await t.clock.advance(1000);
		await openSpot(t);
		expect(t.sockets.count(SPOT)).toBe(2);
		expect(t.venue.count("GET /api/v3/time")).toBe(2);
	});

	test("an unanswered subscription times out after 10 s and reconnects", async () => {
		const t = setup("spot");
		await openSpot(t);
		await t.clock.advance(9_999);
		expect(t.log).toEqual([]);
		await t.clock.advance(1);
		expect(t.log).toEqual(["error", "down"]);
		expect(t.errors[0]).toMatchObject({ kind: "timeout", method: "WS" });
		await t.clock.advance(1000);
		expect(t.sockets.count(SPOT)).toBe(2);
	});

	test.each(["serverShutdown", "eventStreamTerminated"])(
		"%s reconnects",
		async (e) => {
			const t = setup("spot");
			await spotUp(t);
			t.sockets.latest(SPOT).message({ event: { e, E: 1 } });
			await t.clock.advance(1000);
			expect(t.log).toEqual(["up", "down"]);
			expect(t.sockets.count(SPOT)).toBe(2);
		},
	);

	test("a frame that is not JSON is a decode error and reconnects", async () => {
		const t = setup("spot");
		await spotUp(t);
		t.sockets.latest(SPOT).message("not json");
		await t.clock.advance(1000);
		expect(t.log).toEqual(["up", "error", "down"]);
		expect(t.errors[0]).toMatchObject({ kind: "decode", method: "WS" });
		expect(t.sockets.count(SPOT)).toBe(2);
	});

	test("rotates the connection after 23 h", async () => {
		const t = setup("spot");
		await spotUp(t);
		await t.clock.advance(23 * HOUR - 1);
		expect(t.log).toEqual(["up"]);
		await t.clock.advance(1);
		expect(t.log).toEqual(["up", "down"]);
		await t.clock.advance(1000);
		await spotUp(t);
		expect(t.log).toEqual(["up", "down", "up"]);
	});

	test("close() clears every timer and silences the listener", async () => {
		const t = setup("spot");
		await spotUp(t);
		t.stream.close();
		expect(t.clock.pending()).toBe(0);
		t.sockets.latest(SPOT).drop();
		await t.clock.advance(HOUR);
		expect(t.log).toEqual(["up"]);
	});
});

describe("openFuturesUserStream", () => {
	test("connects to the private path with a fresh listen key", async () => {
		const t = setup("futures");
		await futuresUp(t);
		expect(t.sockets.latest(FUTURES).url).toBe(`${FUTURES}lk-1`);
		expect(t.log).toEqual(["up"]);
		t.sockets.latest(FUTURES).message({ e: "ORDER_TRADE_UPDATE", E: 3 });
		t.sockets.latest(FUTURES).message({ result: null, id: 1 });
		expect(t.events).toEqual([{ e: "ORDER_TRADE_UPDATE", E: 3 }]);
	});

	test("live uses the live private path", async () => {
		const t = setup("futures", "live");
		await until(() => t.sockets.all.length > 0);
		expect(t.sockets.all[0]?.url).toBe(
			"wss://fstream.binance.com/private/ws/lk-1",
		);
	});

	test("keeps the listen key alive every 30 min", async () => {
		const t = setup("futures");
		await futuresUp(t);
		await t.clock.advance(30 * MINUTE - 1);
		expect(t.venue.count("PUT /fapi/v1/listenKey")).toBe(0);
		await t.clock.advance(1);
		expect(t.venue.count("PUT /fapi/v1/listenKey")).toBe(1);
		await t.clock.advance(30 * MINUTE);
		expect(t.venue.count("PUT /fapi/v1/listenKey")).toBe(2);
		expect(t.log).toEqual(["up"]);
	});

	test("a -1125 keepalive reconnects with a new listen key", async () => {
		const t = setup("futures");
		await futuresUp(t);
		t.venue.put = () =>
			Response.json(
				{ code: -1125, msg: "This listenKey does not exist." },
				{ status: 400 },
			);
		await t.clock.advance(30 * MINUTE);
		expect(t.log).toEqual(["up", "down"]);
		await t.clock.advance(1000);
		expect(t.venue.count("POST /fapi/v1/listenKey")).toBe(2);
		expect(t.sockets.latest(FUTURES).url).toBe(`${FUTURES}lk-2`);
	});

	test("another keepalive failure is reported and the schedule kept", async () => {
		const t = setup("futures");
		await futuresUp(t);
		t.venue.put = () => new Response("oops", { status: 500 });
		await t.clock.advance(30 * MINUTE);
		expect(t.log).toEqual(["up", "error"]);
		expect(t.errors[0]).toMatchObject({ kind: "http", status: 500 });
		t.venue.put = null;
		await t.clock.advance(30 * MINUTE);
		expect(t.venue.count("PUT /fapi/v1/listenKey")).toBe(2);
		expect(t.sockets.count(FUTURES)).toBe(1);
		expect(t.log).toEqual(["up", "error"]);
	});

	test("listenKeyExpired reconnects", async () => {
		const t = setup("futures");
		await futuresUp(t);
		t.sockets.latest(FUTURES).message({ e: "listenKeyExpired", E: 1 });
		await t.clock.advance(1000);
		expect(t.log).toEqual(["up", "down"]);
		expect(t.sockets.count(FUTURES)).toBe(2);
	});

	test("rotates the connection after 23 h", async () => {
		const t = setup("futures");
		await futuresUp(t);
		await t.clock.advance(23 * HOUR - 1);
		expect(t.log).toEqual(["up"]);
		expect(t.venue.count("PUT /fapi/v1/listenKey")).toBe(45);
		await t.clock.advance(1);
		expect(t.log).toEqual(["up", "down"]);
		await t.clock.advance(1000);
		await futuresUp(t);
		expect(t.sockets.count(FUTURES)).toBe(2);
		expect(t.log).toEqual(["up", "down", "up"]);
	});

	test("a failed listen key request is an error and a failed attempt", async () => {
		const t = setup("futures");
		t.venue.post = () => new Response("down", { status: 503 });
		await until(() => t.log.length === 2);
		expect(t.log).toEqual(["error", "down"]);
		expect(t.errors[0]).toMatchObject({
			kind: "http",
			method: "POST",
			path: "/fapi/v1/listenKey",
		});
		t.venue.post = null;
		await t.clock.advance(1000);
		await futuresUp(t);
		expect(t.sockets.latest(FUTURES).url).toBe(`${FUTURES}lk-1`);
	});

	test("close() clears every timer and silences the listener", async () => {
		const t = setup("futures");
		await futuresUp(t);
		t.stream.close();
		expect(t.clock.pending()).toBe(0);
		t.sockets.latest(FUTURES).drop();
		await t.clock.advance(HOUR);
		expect(t.log).toEqual(["up"]);
		expect(t.venue.count("PUT /fapi/v1/listenKey")).toBe(0);
	});
});
