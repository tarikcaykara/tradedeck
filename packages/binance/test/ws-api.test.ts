import { describe, expect, test } from "bun:test";
import {
	createHmac,
	createPublicKey,
	generateKeyPairSync,
	verify,
} from "node:crypto";
import { createSigner } from "@tradedeck/adapter";
import { createBinanceHttp } from "../src/http.ts";
import { wsApiPayload } from "../src/ws-api.ts";

// binance-spot-api-docs, web-socket-api.md, "SIGNED request example (HMAC)".
const DOC_API_KEY =
	"vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A";
const DOC_SECRET =
	"NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";

describe("wsApiPayload", () => {
	const signer = createSigner({
		kind: "hmac",
		apiKey: DOC_API_KEY,
		secret: DOC_SECRET,
	});

	test("reproduces the ASCII doc example", () => {
		const payload = wsApiPayload({
			symbol: "BTCUSDT",
			side: "SELL",
			type: "LIMIT",
			timeInForce: "GTC",
			quantity: "0.01000000",
			price: "52000.00",
			recvWindow: 100,
			timestamp: 1645423376532,
			apiKey: DOC_API_KEY,
			signature: "------ FILL ME ------",
		});
		expect(payload).toBe(
			`apiKey=${DOC_API_KEY}&price=52000.00&quantity=0.01000000&recvWindow=100&side=SELL&symbol=BTCUSDT&timeInForce=GTC&timestamp=1645423376532&type=LIMIT`,
		);
		expect(signer.sign(payload)).toBe(
			"aa1b5712c094bc4e57c05a1a5c1fd8d88dcd628338ea863fec7b88e59fe2db24",
		);
	});

	test("reproduces the non-ASCII doc example without percent-encoding", () => {
		const payload = wsApiPayload({
			symbol: "１２３４５６",
			side: "BUY",
			type: "LIMIT",
			timeInForce: "GTC",
			quantity: "1.00000000",
			price: "0.10000000",
			recvWindow: 5000,
			timestamp: 1645423376532,
			apiKey: DOC_API_KEY,
		});
		expect(payload).toBe(
			`apiKey=${DOC_API_KEY}&price=0.10000000&quantity=1.00000000&recvWindow=5000&side=BUY&symbol=１２３４５６&timeInForce=GTC&timestamp=1645423376532&type=LIMIT`,
		);
		expect(signer.sign(payload)).toBe(
			"b33892ae8e687c939f4468c6268ddd4c40ac1af18ad19a064864c47bae0752cd",
		);
	});
});

/** Answers the spot time endpoint only; records every path. */
function spotTime(serverTime: number) {
	const paths: string[] = [];
	return {
		paths,
		fetch: async (url: string) => {
			const { pathname } = new URL(url);
			paths.push(pathname);
			return pathname === "/api/v3/time"
				? Response.json({ serverTime })
				: new Response("unexpected", { status: 500 });
		},
	};
}

describe("BinanceHttp.signWsApi", () => {
	test("HMAC: params, apiKey and the spot server timestamp, signed in name order", async () => {
		const venue = spotTime(1_700_000_000_250);
		const http = createBinanceHttp({
			environment: "demo",
			credential: { kind: "hmac", apiKey: "key-1", secret: "secret-1" },
			fetch: venue.fetch,
			now: () => 1_700_000_000_000,
		});
		const signed = await http.signWsApi({ symbol: "BTCUSDT" });
		const expected = createHmac("sha256", "secret-1")
			.update("apiKey=key-1&symbol=BTCUSDT&timestamp=1700000000250")
			.digest("hex");
		expect(signed).toEqual({
			symbol: "BTCUSDT",
			apiKey: "key-1",
			timestamp: 1_700_000_000_250,
			signature: expected,
		});
		expect(venue.paths).toEqual(["/api/v3/time"]);
	});

	test("Ed25519: a raw base64 signature that verifies with the public key", async () => {
		const { privateKey } = generateKeyPairSync("ed25519");
		const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const http = createBinanceHttp({
			environment: "demo",
			credential: { kind: "ed25519", apiKey: "key-2", privateKeyPem: pem },
			fetch: spotTime(1_000).fetch,
			now: () => 1_000,
		});
		const { signature } = await http.signWsApi({});
		if (typeof signature !== "string") throw new Error("no signature");
		expect(signature).not.toContain("%");
		expect(
			verify(
				null,
				Buffer.from("apiKey=key-2&timestamp=1000", "utf8"),
				createPublicKey(privateKey),
				Buffer.from(signature, "base64"),
			),
		).toBe(true);
	});

	test("invalidateClock('spot') resyncs before the next signature", async () => {
		const venue = spotTime(5_000);
		const http = createBinanceHttp({
			environment: "demo",
			credential: { kind: "hmac", apiKey: "k", secret: "s" },
			fetch: venue.fetch,
			now: () => 5_000,
		});
		await http.signWsApi({});
		await http.signWsApi({});
		expect(venue.paths).toEqual(["/api/v3/time"]);
		http.invalidateClock("spot");
		await http.signWsApi({});
		expect(venue.paths).toEqual(["/api/v3/time", "/api/v3/time"]);
	});
});
