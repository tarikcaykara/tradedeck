import { describe, expect, test } from "bun:test";
import { type Fetch, VenueError } from "@tradedeck/adapter";
import { z } from "zod";
import {
	measureClockOffset,
	probeUserStream,
	withinRecvWindow,
} from "../src/doctor.ts";
import { createBinanceHttp } from "../src/http.ts";
import { manualClock } from "./support/clock.ts";
import { type FakeWebSockets, fakeWebSockets } from "./support/fake-ws.ts";
import { until } from "./support/wait.ts";

const credential = { kind: "hmac", apiKey: "k", secret: "s" } as const;
const SPOT = "wss://demo-ws-api.binance.com/ws-api/v3";
const FUTURES = "wss://demo-fstream.binance.com/private/ws/";
const TIMEOUT_MS = 15_000;

describe("measureClockOffset", () => {
	test.each([
		["spot", "/api/v3/time"],
		["futures", "/fapi/v1/time"],
	] as const)(
		"%s: server time minus the local midpoint of the request",
		async (host, path) => {
			const paths: string[] = [];
			const http = createBinanceHttp({
				environment: "demo",
				credential,
				fetch: async (url) => {
					paths.push(new URL(url).pathname);
					return Response.json({ serverTime: 1_600 });
				},
			});
			const times = [1_000, 1_200];
			const offset = await measureClockOffset(
				http,
				host,
				() => times.shift() ?? 0,
			);
			expect(offset).toBe(500);
			expect(paths).toEqual([path]);
		},
	);
});

describe("withinRecvWindow", () => {
	// Binance accepts `timestamp < serverTime + 1000` and
	// `serverTime − timestamp ≤ recvWindow` (5000).
	test.each([
		[-1000, false],
		[-999, true],
		[0, true],
		[5000, true],
		[5001, false],
	])("offset %p ms → %p", (offsetMs, accepted) => {
		expect(withinRecvWindow(offsetMs)).toBe(accepted);
	});
});

function setup() {
	const clock = manualClock();
	const sockets = fakeWebSockets();
	const calls: string[] = [];
	const venue = {
		listenKey: (): Response => Response.json({ listenKey: "lk1" }),
	};
	const fetch: Fetch = async (url, init) => {
		const { pathname } = new URL(url);
		calls.push(`${init.method ?? "GET"} ${pathname}`);
		if (pathname === "/api/v3/time" || pathname === "/fapi/v1/time") {
			return Response.json({ serverTime: clock.now() });
		}
		if (pathname === "/fapi/v1/listenKey") return venue.listenKey();
		return new Response("unexpected", { status: 500 });
	};
	const deps = {
		environment: "demo",
		http: createBinanceHttp({
			environment: "demo",
			credential,
			fetch,
			now: clock.now,
		}),
		now: clock.now,
		timers: clock.timers,
		WebSocket: sockets.WebSocket,
	} as const;
	return { clock, sockets, calls, venue, deps };
}

const SubscribeRequest = z.object({ id: z.string() });

/** Opens the spot socket and returns the id of its subscribe request once sent. */
async function spotSubscribe(sockets: FakeWebSockets): Promise<string> {
	await until(() => sockets.count(SPOT) > 0);
	const ws = sockets.latest(SPOT);
	ws.open();
	await until(() => ws.sent.length === 1);
	return SubscribeRequest.parse(ws.frames()[0]).id;
}

describe("probeUserStream", () => {
	test("futures: resolves once the socket is open, then closes it and every timer", async () => {
		const t = setup();
		const probe = probeUserStream("futures", t.deps, TIMEOUT_MS);
		await until(() => t.sockets.count(FUTURES) > 0);
		t.sockets.latest(FUTURES).open();
		await probe;
		expect(t.sockets.latest(FUTURES).url).toBe(`${FUTURES}lk1`);
		expect(t.sockets.latest(FUTURES).readyState).toBe(3);
		expect(t.clock.pending()).toBe(0);
		// The key is neither kept alive nor deleted: it lapses on its own.
		expect(t.calls).toEqual(["POST /fapi/v1/listenKey"]);
	});

	test("futures: a failed listen key request rejects with the venue error, no socket", async () => {
		const t = setup();
		t.venue.listenKey = () => new Response("down", { status: 503 });
		const err = await probeUserStream("futures", t.deps, TIMEOUT_MS).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(VenueError);
		expect(err).toMatchObject({
			kind: "http",
			method: "POST",
			path: "/fapi/v1/listenKey",
			status: 503,
		});
		expect(t.sockets.count(FUTURES)).toBe(0);
		expect(t.clock.pending()).toBe(0);
	});

	test("a stream not up within the timeout rejects and is closed", async () => {
		const t = setup();
		const probe = probeUserStream("futures", t.deps, TIMEOUT_MS).catch(
			(e: unknown) => e,
		);
		await until(() => t.sockets.count(FUTURES) > 0);
		await t.clock.advance(TIMEOUT_MS - 1);
		expect(t.sockets.latest(FUTURES).readyState).toBe(0);
		await t.clock.advance(1);
		expect(await probe).toEqual(new Error("not up within 15 s"));
		expect(t.sockets.latest(FUTURES).readyState).toBe(3);
		expect(t.clock.pending()).toBe(0);
	});

	test("a connection that closes before it is up rejects at the first attempt", async () => {
		const t = setup();
		const probe = probeUserStream("futures", t.deps, TIMEOUT_MS).catch(
			(e: unknown) => e,
		);
		await until(() => t.sockets.count(FUTURES) > 0);
		t.sockets.latest(FUTURES).drop();
		expect(await probe).toEqual(
			new Error("the connection closed before it was up"),
		);
		expect(t.sockets.count(FUTURES)).toBe(1);
		expect(t.clock.pending()).toBe(0);
	});

	test("spot: resolves once the subscription is accepted, then closes", async () => {
		const t = setup();
		const probe = probeUserStream("spot", t.deps, TIMEOUT_MS);
		const id = await spotSubscribe(t.sockets);
		t.sockets.latest(SPOT).message({ id, status: 200, result: {} });
		await probe;
		expect(t.sockets.latest(SPOT).readyState).toBe(3);
		expect(t.clock.pending()).toBe(0);
	});

	test("spot: a refused subscription rejects with the venue's message", async () => {
		const t = setup();
		const probe = probeUserStream("spot", t.deps, TIMEOUT_MS).catch(
			(e: unknown) => e,
		);
		const id = await spotSubscribe(t.sockets);
		t.sockets.latest(SPOT).message({
			id,
			status: 400,
			error: { code: -2015, msg: "Invalid API-key, IP, or permissions." },
		});
		const err = await probe;
		expect(err).toBeInstanceOf(VenueError);
		expect(err).toHaveProperty(
			"message",
			"WS userDataStream.subscribe.signature → 400 -2015: Invalid API-key, IP, or permissions.",
		);
		expect(t.sockets.count(SPOT)).toBe(1);
		expect(t.clock.pending()).toBe(0);
	});
});
