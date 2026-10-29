import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { BINANCE_HOSTS } from "../src/env.ts";
import {
	AUTH_PARAMS,
	type Recording,
	SCRUBBED_KEYS,
	SCRUBBED_STRING,
	type StreamRecording,
	scrubBody,
	toRecording,
} from "../src/recording.ts";

const RECORDINGS = `${import.meta.dir}/../__recordings__`;

describe("scrubBody", () => {
	test("replaces every identifying value at any depth, keeping its JSON type", () => {
		expect(
			scrubBody({
				uid: 354937868,
				listenKey:
					"pqia91ma19a5s61cv6a81va65sdf19v8a65a1a5s61cv6a81va65sdf19v8a65a1",
				nested: [{ apiKey: "vmPUZE6mv9SD5VNHk4Hl", keep: "x" }],
				assets: [{ accountAlias: "SgsR", tradeGroupId: -1, flag: true }],
			}),
		).toEqual({
			uid: 0,
			listenKey: SCRUBBED_STRING,
			nested: [{ apiKey: SCRUBBED_STRING, keep: "x" }],
			assets: [{ accountAlias: SCRUBBED_STRING, tradeGroupId: 0, flag: true }],
		});
	});
});

describe("toRecording", () => {
	test("drops the auth params, keeps the rest, and scrubs the body", () => {
		const recording = toRecording(
			{
				url: "https://demo-fapi.binance.com/fapi/v3/positionRisk?symbol=%E5%B8%81%E5%AE%89%E4%BA%BA%E7%94%9FUSDT&recvWindow=5000&timestamp=1&signature=abc",
				method: "GET",
				status: 200,
				contentType: "application/json",
				text: '[{"symbol":"币安人生USDT","uid":7}]',
			},
			BINANCE_HOSTS.demo,
		);
		expect(recording).toEqual({
			request: {
				host: "futures",
				method: "GET",
				path: "/fapi/v3/positionRisk",
				params: { symbol: "币安人生USDT" },
			},
			status: 200,
			contentType: "application/json",
			body: [{ symbol: "币安人生USDT", uid: 0 }],
		});
	});

	test("keeps a non-JSON body as text", () => {
		const recording = toRecording(
			{
				url: "https://demo-api.binance.com/sapi/v1/account/apiRestrictions?timestamp=1&signature=abc",
				method: "GET",
				status: 404,
				contentType: "text/html",
				text: "<html>404 Not Found</html>",
			},
			BINANCE_HOSTS.demo,
		);
		expect(recording.body).toBe("<html>404 Not Found</html>");
		expect(recording.request.params).toEqual({});
	});

	test("refuses a host outside the environment", () => {
		expect(() =>
			toRecording(
				{
					url: "https://api.binance.com/api/v3/account",
					method: "GET",
					status: 200,
					contentType: "application/json",
					text: "{}",
				},
				BINANCE_HOSTS.demo,
			),
		).toThrow("recording: https://api.binance.com is not a known host");
	});
});

/** Paths of every value stored under a scrubbed key that is not a placeholder. */
function unscrubbed(value: unknown, at = ""): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((v, i) => unscrubbed(v, `${at}[${i}]`));
	}
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([k, v]) =>
		SCRUBBED_KEYS.has(k) &&
		![SCRUBBED_STRING, 0, false, null].includes(v as never)
			? [`${at}.${k}`]
			: unscrubbed(v, `${at}.${k}`),
	);
}

const files = await Array.fromAsync(
	new Glob("**/*.json").scan({ cwd: RECORDINGS }),
).catch((): string[] => []);
const isStream = (file: string) => file.split("/").includes("streams");

describe("committed recordings", () => {
	test.each(files.filter((f) => !isStream(f)))(
		"%s is scrubbed",
		async (file) => {
			const text = await Bun.file(`${RECORDINGS}/${file}`).text();
			const recording = JSON.parse(text) as Recording;
			expect(
				Object.keys(recording.request.params).filter((k) => AUTH_PARAMS.has(k)),
			).toEqual([]);
			expect(unscrubbed(recording.body)).toEqual([]);
			expect(text).not.toMatch(/X-MBX-APIKEY|signature=|timestamp=/i);
		},
	);

	test.each(files.filter(isStream))(
		"%s is scrubbed and holds events",
		async (file) => {
			const text = await Bun.file(`${RECORDINGS}/${file}`).text();
			const recording = JSON.parse(text) as StreamRecording;
			expect(unscrubbed(recording)).toEqual([]);
			expect(text).not.toMatch(/X-MBX-APIKEY|signature=|timestamp=/i);
			expect(recording.steps.flatMap((s) => s.events).length).toBeGreaterThan(
				0,
			);
		},
	);
});
