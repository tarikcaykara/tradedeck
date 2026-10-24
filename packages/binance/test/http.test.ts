import { describe, expect, test } from "bun:test";
import { VenueError } from "@tradedeck/adapter";
import { z } from "zod";
import { ENDPOINTS } from "../src/endpoints.ts";
import { createBinanceHttp } from "../src/http.ts";

const credential = { kind: "hmac", apiKey: "k", secret: "s" } as const;
const Ok = z.object({ ok: z.literal(true) });

/** Answers the time endpoints; `respond` answers everything else. */
function fakeVenue(respond: (path: string) => Response) {
	const urls: string[] = [];
	return {
		urls,
		paths: () => urls.map((u) => new URL(u).pathname),
		fetch: async (url: string) => {
			urls.push(url);
			const { pathname } = new URL(url);
			if (pathname === "/api/v3/time" || pathname === "/fapi/v1/time") {
				return Response.json({ serverTime: 1_000_000 });
			}
			return respond(pathname);
		},
	};
}

const venueError = (code: number, status = 400) =>
	Response.json({ code, msg: "x" }, { status });

describe("createBinanceHttp", () => {
	test("-1021 resyncs the clock and retries exactly once", async () => {
		let calls = 0;
		const venue = fakeVenue(() =>
			++calls === 1 ? venueError(-1021) : Response.json({ ok: true }),
		);
		const http = createBinanceHttp({
			environment: "demo",
			credential,
			fetch: venue.fetch,
			now: () => 1_000_000,
		});
		expect(await http.get(ENDPOINTS.spotAccount, Ok)).toEqual({ ok: true });
		expect(venue.paths()).toEqual([
			"/api/v3/time",
			"/api/v3/account",
			"/api/v3/time",
			"/api/v3/account",
		]);
	});

	test("a second -1021 rejects without a third attempt", async () => {
		const venue = fakeVenue(() => venueError(-1021));
		const http = createBinanceHttp({
			environment: "demo",
			credential,
			fetch: venue.fetch,
		});
		const err = await http
			.get(ENDPOINTS.positionRisk, Ok)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(VenueError);
		expect((err as VenueError).code).toBe("-1021");
		expect(
			venue.paths().filter((p) => p === "/fapi/v3/positionRisk"),
		).toHaveLength(2);
	});

	test.each([
		["-1022", () => venueError(-1022)],
		["5xx", () => new Response("down", { status: 503 })],
	])("%s is never retried", async (_, respond) => {
		const venue = fakeVenue(respond);
		const http = createBinanceHttp({
			environment: "demo",
			credential,
			fetch: venue.fetch,
		});
		await expect(http.get(ENDPOINTS.spotAccount, Ok)).rejects.toBeInstanceOf(
			VenueError,
		);
		expect(venue.paths().filter((p) => p === "/api/v3/account")).toHaveLength(
			1,
		);
	});

	test("each host keeps its own clock and base URL", async () => {
		const venue = fakeVenue(() => Response.json({ ok: true }));
		const http = createBinanceHttp({
			environment: "live",
			credential,
			fetch: venue.fetch,
		});
		await http.get(ENDPOINTS.spotAccount, Ok);
		await http.get(ENDPOINTS.spotOpenOrders, Ok);
		expect(venue.urls.map((u) => new URL(u).origin)).toEqual([
			"https://api.binance.com",
			"https://api.binance.com",
			"https://api.binance.com",
		]);
		await http.get(ENDPOINTS.positionRisk, Ok);
		expect(venue.paths().slice(3)).toEqual([
			"/fapi/v1/time",
			"/fapi/v3/positionRisk",
		]);
		expect(new URL(venue.urls[4] ?? "").origin).toBe(
			"https://fapi.binance.com",
		);
	});

	test("endpoint params come first, call params after", async () => {
		const venue = fakeVenue(() => Response.json({ ok: true }));
		const http = createBinanceHttp({
			environment: "demo",
			credential,
			fetch: venue.fetch,
		});
		await http.get(ENDPOINTS.spotAccount, Ok, { extra: 1 });
		expect(venue.urls[1]).toStartWith(
			"https://demo-api.binance.com/api/v3/account?omitZeroBalances=true&extra=1&recvWindow=5000&timestamp=",
		);
	});

	test("a body that does not match the schema → decode error naming the field", async () => {
		const venue = fakeVenue(() => Response.json({ ok: "yes" }));
		const http = createBinanceHttp({
			environment: "demo",
			credential,
			fetch: venue.fetch,
		});
		const err = await http
			.get(ENDPOINTS.spotAccount, Ok)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(VenueError);
		expect((err as VenueError).kind).toBe("decode");
		expect((err as VenueError).message).toStartWith(
			"GET /api/v3/account → decode: unexpected response at ok:",
		);
	});
});
