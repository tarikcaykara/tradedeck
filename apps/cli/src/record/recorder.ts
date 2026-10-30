import { mkdir, rm } from "node:fs/promises";
import type { Fetch } from "@tradedeck/adapter";
import {
	BINANCE_HOSTS,
	createBinanceHttp,
	ENDPOINTS,
	type EndpointName,
	pickSymbols,
	type Recording,
	toRecording,
	trimSymbols,
} from "@tradedeck/binance";
import type { Credential } from "@tradedeck/core";
import { z } from "zod";

interface Exchange {
	url: string;
	method: string;
	status: number;
	contentType: string;
	text: string;
}

/**
 * Sends every endpoint of `ENDPOINTS` to Binance Demo through the adapter's
 * own clients, then writes one scrubbed, trimmed recording per endpoint to
 * `<outDir>/<scenario>/`. Failed requests are recorded too (e.g. Demo's
 * `/sapi` 404). Returns one summary line per endpoint.
 */
export async function recordScenario(opts: {
	credential: Credential;
	scenario: string;
	outDir: URL;
	/** Default `globalThis.fetch`. */
	fetch?: Fetch;
	onWarn?: (message: string) => void;
}): Promise<string[]> {
	const base = opts.fetch ?? globalThis.fetch;
	const exchanges: Exchange[] = [];
	const fetch: Fetch = async (url, init) => {
		const res = await base(url, init);
		exchanges.push({
			url,
			method: init.method ?? "GET",
			status: res.status,
			contentType: res.headers.get("content-type") ?? "",
			text: await res.clone().text(),
		});
		return res;
	};
	const http = createBinanceHttp({
		environment: "demo",
		credential: opts.credential,
		fetch,
	});

	const names = Object.keys(ENDPOINTS) as EndpointName[];
	for (const name of names) {
		// The time endpoints are recorded when the clocks sync.
		if (name === "spotTime" || name === "futuresTime") continue;
		const endpoint = ENDPOINTS[name];
		await http.request(endpoint, z.unknown()).catch((err: unknown) => {
			opts.onWarn?.(
				`${endpoint.path}: ${err instanceof Error ? err.message : "failed"}`,
			);
		});
	}

	// The last exchange per endpoint wins: a -1021 retry records twice.
	const recordings: Partial<Record<EndpointName, Recording>> = {};
	for (const exchange of exchanges) {
		const recording = toRecording(exchange, BINANCE_HOSTS.demo);
		const name = names.find(
			(n) =>
				ENDPOINTS[n].host === recording.request.host &&
				ENDPOINTS[n].method === recording.request.method &&
				ENDPOINTS[n].path === recording.request.path,
		);
		if (name !== undefined) recordings[name] = recording;
	}
	const keep = pickSymbols(
		Object.fromEntries(Object.entries(recordings).map(([n, r]) => [n, r.body])),
	);

	const dir = new URL(`${opts.scenario}/`, opts.outDir);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	const lines: string[] = [];
	for (const name of names) {
		const recording = recordings[name];
		if (recording === undefined) {
			lines.push(`${name}: not recorded`);
			continue;
		}
		const symbols = ENDPOINTS[name].host === "spot" ? keep.spot : keep.futures;
		const trimmed = trimSymbols(name, recording, symbols);
		const json = `${JSON.stringify(trimmed, null, "\t")}\n`;
		await Bun.write(new URL(`${name}.json`, dir), json);
		lines.push(
			`${name}: ${trimmed.status} ${trimmed.request.path} (${json.length} bytes)${trimmed.note ? `, ${trimmed.note}` : ""}`,
		);
	}
	return lines;
}
