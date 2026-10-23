import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createServerClock, type ServerClock } from "../src/clock.ts";
import { VenueError } from "../src/errors.ts";
import { createRestClient, type Fetch, type RestRequest } from "../src/rest.ts";
import { createSigner } from "../src/signer.ts";

// Binance spot API docs, rest-api.md, "SIGNED Endpoint Examples" (HMAC): the
// ASCII and the non-ASCII example requests, as the doc's curl URLs.
const DOC_API_KEY =
	"vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A";
const DOC_SECRET =
	"NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
const DOC_TAIL =
	"&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
const DOC_REQUESTS = [
	[
		"LTCBTC",
		`https://api.binance.com/api/v3/order?symbol=LTCBTC${DOC_TAIL}&signature=c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71`,
	],
	[
		"１２３４５６",
		`https://api.binance.com/api/v3/order?symbol=%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95%EF%BC%96${DOC_TAIL}&signature=e1353ec6b14d888f1164ae9af8228a3dbd508bc82eb867db8ab6046442f33ef3`,
	],
] as const;

// RFC 8032 §7.1, TEST 2, as PKCS#8.
const RFC8032_PEM = [
	"-----BEGIN PRIVATE KEY-----",
	"MC4CAQAwBQYDK2VwBCIEIEzNCJso/5banbbDRuwRTg9bijGfNaumJNqM9u1PuKb7",
	"-----END PRIVATE KEY-----",
].join("\n");

const HEADER = "X-MBX-APIKEY";
const BASE = "https://venue.test";

interface Call {
	url: string;
	method: string;
	headers: Headers;
}

function recorder(
	respond: (init: RequestInit) => Response | Promise<Response> = () =>
		Response.json({ ok: true }),
): { calls: Call[]; fetch: Fetch } {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({
				url,
				method: init.method ?? "GET",
				headers: new Headers(init.headers),
			});
			return respond(init);
		},
	};
}

const fixedClock = (ts: number): ServerClock => ({
	timestamp: async () => ts,
	invalidate() {},
});

const hmac = createSigner({
	kind: "hmac",
	apiKey: DOC_API_KEY,
	secret: DOC_SECRET,
});

const signedGet: RestRequest = {
	method: "GET",
	path: "/api/v3/account",
	params: { omitZeroBalances: true },
	auth: "signed",
};

/** The query exactly as signed, and the transmitted signature value. */
function splitSigned(url: string): { query: string; signature: string } {
	const [head = "", signature = ""] = url.split("&signature=");
	return { query: head.slice(head.indexOf("?") + 1), signature };
}

describe("signed requests", () => {
	test.each(DOC_REQUESTS)(
		"reproduce the Binance documentation request for %s",
		async (symbol, url) => {
			const { calls, fetch } = recorder();
			const client = createRestClient({
				baseUrl: "https://api.binance.com",
				fetch,
				signer: hmac,
				apiKeyHeader: HEADER,
				clock: fixedClock(1499827319559),
				recvWindow: 5000,
			});
			await client.request({
				method: "POST",
				path: "/api/v3/order",
				params: {
					symbol,
					side: "BUY",
					type: "LIMIT",
					timeInForce: "GTC",
					quantity: "1",
					price: "0.1",
				},
				auth: "signed",
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe(url);
			expect(calls[0]?.method).toBe("POST");
			expect(calls[0]?.headers.get(HEADER)).toBe(DOC_API_KEY);
		},
	);

	test("percent-encode the base64 Ed25519 signature over the transmitted query", async () => {
		const { calls, fetch } = recorder();
		const signer = createSigner({
			kind: "ed25519",
			apiKey: "ed-key",
			privateKeyPem: RFC8032_PEM,
		});
		const client = createRestClient({
			baseUrl: BASE,
			fetch,
			signer,
			apiKeyHeader: HEADER,
			clock: fixedClock(1_700_000_000_000),
		});
		await client.request(signedGet);
		const { query, signature } = splitSigned(calls[0]?.url ?? "");
		expect(query).toBe(
			"omitZeroBalances=true&recvWindow=5000&timestamp=1700000000000",
		);
		expect(signature).not.toMatch(/[+/=]/);
		expect(signature).toEndWith("%3D%3D");
		expect(decodeURIComponent(signature)).toBe(signer.sign(query));
		expect(calls[0]?.headers.get(HEADER)).toBe("ed-key");
	});

	test("carry the server-time offset in the timestamp", async () => {
		const { calls, fetch } = recorder();
		const client = createRestClient({
			baseUrl: BASE,
			fetch,
			signer: hmac,
			apiKeyHeader: HEADER,
			clock: createServerClock({
				now: () => 1_000_000,
				fetchServerTime: async () => 1_002_500,
			}),
		});
		await client.request(signedGet);
		expect(splitSigned(calls[0]?.url ?? "").query).toContain(
			"&timestamp=1002500",
		);
	});
});

describe("server clock", () => {
	let t = 0;
	let skew = 0;
	let syncs = 0;
	const clockOpts = {
		now: () => t,
		fetchServerTime: async () => {
			syncs++;
			return t + skew;
		},
		maxAgeMs: 60_000,
	};

	afterEach(() => {
		t = 1_000_000;
		skew = 0;
		syncs = 0;
	});

	test("concurrent callers share one sync", async () => {
		t = 1_000_000;
		const clock = createServerClock(clockOpts);
		const [a, b] = await Promise.all([clock.timestamp(), clock.timestamp()]);
		expect(syncs).toBe(1);
		expect(a).toBe(b);
	});

	test("resyncs once maxAgeMs has elapsed or after invalidate()", async () => {
		t = 1_000_000;
		skew = 2500;
		const clock = createServerClock(clockOpts);
		expect(await clock.timestamp()).toBe(1_002_500);

		t += 59_999;
		skew = 4000;
		expect(await clock.timestamp()).toBe(t + 2500);
		expect(syncs).toBe(1);

		t += 1;
		expect(await clock.timestamp()).toBe(t + 4000);
		expect(syncs).toBe(2);

		skew = -700;
		clock.invalidate();
		expect(await clock.timestamp()).toBe(t - 700);
		expect(syncs).toBe(3);
	});

	test("a failed sync rejects and leaves the clock unsynced", async () => {
		let calls = 0;
		const clock = createServerClock({
			now: () => 1_000_000,
			fetchServerTime: () => {
				calls++;
				if (calls === 1) throw new Error("time endpoint down");
				return Promise.resolve(1_000_300);
			},
		});
		await expect(clock.timestamp()).rejects.toThrow("time endpoint down");
		expect(await clock.timestamp()).toBe(1_000_300);
		expect(calls).toBe(2);
	});
});

describe("unsigned requests", () => {
	test("auth none: no key header, timestamp or signature", async () => {
		const { calls, fetch } = recorder();
		const client = createRestClient({
			baseUrl: BASE,
			fetch,
			signer: hmac,
			apiKeyHeader: HEADER,
			clock: fixedClock(1),
		});
		await client.request({
			method: "GET",
			path: "/api/v3/exchangeInfo",
			params: { symbols: '["BTCUSDT","ETHUSDT"]' },
			auth: "none",
		});
		await client.request({ method: "GET", path: "/api/v3/time", auth: "none" });
		expect(calls[0]?.url).toBe(
			`${BASE}/api/v3/exchangeInfo?symbols=%5B%22BTCUSDT%22%2C%22ETHUSDT%22%5D`,
		);
		expect(calls[0]?.headers.has(HEADER)).toBe(false);
		expect(calls[1]?.url).toBe(`${BASE}/api/v3/time`);
	});

	test("auth apiKey: key header only", async () => {
		const { calls, fetch } = recorder();
		const client = createRestClient({
			baseUrl: BASE,
			fetch,
			signer: hmac,
			apiKeyHeader: HEADER,
		});
		await client.request({
			method: "POST",
			path: "/api/v3/userDataStream",
			auth: "apiKey",
		});
		expect(calls[0]?.url).toBe(`${BASE}/api/v3/userDataStream`);
		expect(calls[0]?.headers.get(HEADER)).toBe(DOC_API_KEY);
	});
});

async function failure(
	respond: (init: RequestInit) => Response | Promise<Response>,
	opts: { timeoutMs?: number } = {},
): Promise<VenueError> {
	const client = createRestClient({
		baseUrl: BASE,
		fetch: recorder(respond).fetch,
		signer: hmac,
		apiKeyHeader: HEADER,
		clock: fixedClock(1_700_000_000_000),
		...opts,
	});
	try {
		await client.request(signedGet);
	} catch (err) {
		if (err instanceof VenueError) return err;
		throw err;
	}
	throw new Error("request did not fail");
}

function neverAnswers(init: RequestInit): Promise<Response> {
	const { promise, reject } = Promise.withResolvers<Response>();
	init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
	return promise;
}

describe("errors", () => {
	test("venue error body → http with status, code and message", async () => {
		const err = await failure(() =>
			Response.json({ code: -1121, msg: "Invalid symbol." }, { status: 400 }),
		);
		expect(err.name).toBe("VenueError");
		expect(err.kind).toBe("http");
		expect(err.status).toBe(400);
		expect(err.code).toBe("-1121");
		expect(err.retryAfterMs).toBeNull();
		expect(err.message).toBe(
			"GET /api/v3/account → 400 -1121: Invalid symbol.",
		);
	});

	test.each([
		[429, "7", 7000],
		[418, "120", 120_000],
		[429, "soon", null],
		[503, "30", null],
	])(
		"status %d with Retry-After %s → retryAfterMs %p",
		async (status, header, ms) => {
			const err = await failure(() =>
				Response.json(
					{ code: -1003, msg: "Too many requests." },
					{ status, headers: { "Retry-After": header } },
				),
			);
			expect(err.status).toBe(status);
			expect(err.retryAfterMs).toBe(ms);
		},
	);

	test("non-JSON error body → http without a venue code", async () => {
		const err = await failure(
			() =>
				new Response("<html>Service Unavailable</html>", {
					status: 503,
					statusText: "Service Unavailable",
				}),
		);
		expect(err.kind).toBe("http");
		expect(err.status).toBe(503);
		expect(err.code).toBeNull();
		expect(err.message).toBe("GET /api/v3/account → 503: Service Unavailable");
	});

	test("rejected fetch → network", async () => {
		const err = await failure(() => {
			throw new TypeError("Unable to connect");
		});
		expect(err.kind).toBe("network");
		expect(err.status).toBeNull();
		expect(err.message).toBe(
			"GET /api/v3/account → network: Unable to connect",
		);
	});

	test("no response within timeoutMs → timeout", async () => {
		const err = await failure(neverAnswers, { timeoutMs: 20 });
		expect(err.kind).toBe("timeout");
		expect(err.message).toBe(
			"GET /api/v3/account → timeout: no response within 20 ms",
		);
	});

	test("2xx with a non-JSON body → decode", async () => {
		const err = await failure(() => new Response("not json"));
		expect(err.kind).toBe("decode");
		expect(err.status).toBeNull();
	});

	test.each([
		["http", () => Response.json({ code: -1022, msg: "bad" }, { status: 400 })],
		["network", () => Promise.reject(new TypeError("down"))],
		["timeout", neverAnswers],
		["decode", () => new Response("not json")],
	] as const)(
		"%s: the message carries no signature, key or timestamp",
		async (_, respond) => {
			let url = "";
			const client = createRestClient({
				baseUrl: BASE,
				fetch: async (u, init) => {
					url = u;
					return respond(init);
				},
				signer: hmac,
				apiKeyHeader: HEADER,
				clock: fixedClock(1_700_000_000_000),
				timeoutMs: 20,
			});
			const err = await client.request(signedGet).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(VenueError);
			const text = `${(err as Error).message} ${JSON.stringify(err)}`;
			const { signature } = splitSigned(url);
			expect(signature).not.toBe("");
			expect(text).not.toContain(signature);
			expect(text).not.toContain(DOC_API_KEY);
			expect(text).not.toContain("timestamp=");
		},
	);
});

describe("fetch injection and configuration", () => {
	test("an injected fetch is the only fetch called", async () => {
		const global = spyOn(globalThis, "fetch");
		try {
			const { calls, fetch } = recorder();
			const client = createRestClient({
				baseUrl: BASE,
				fetch,
				signer: hmac,
				apiKeyHeader: HEADER,
				clock: fixedClock(1),
			});
			await client.request(signedGet);
			await client.request({
				method: "GET",
				path: "/api/v3/time",
				auth: "none",
			});
			expect(calls).toHaveLength(2);
			expect(global).not.toHaveBeenCalled();
		} finally {
			global.mockRestore();
		}
	});

	test.each([
		[
			"signed request without a signer",
			{ clock: fixedClock(1), apiKeyHeader: HEADER },
			signedGet,
			"rest: signed request needs signer, apiKeyHeader and clock",
		],
		[
			"signed request without a clock",
			{ signer: hmac, apiKeyHeader: HEADER },
			signedGet,
			"rest: signed request needs signer, apiKeyHeader and clock",
		],
		[
			"apiKey request without the header name",
			{ signer: hmac },
			{ ...signedGet, auth: "apiKey" },
			"rest: apiKey request needs signer and apiKeyHeader",
		],
	] as const)("%s throws before any fetch", async (_, config, req, message) => {
		const { calls, fetch } = recorder();
		const client = createRestClient({ baseUrl: BASE, fetch, ...config });
		await expect(client.request(req)).rejects.toThrow(new Error(message));
		expect(calls).toHaveLength(0);
	});
});
