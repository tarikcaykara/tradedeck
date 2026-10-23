import type { Fetch } from "@tradedeck/adapter";
import { ENDPOINTS, type EndpointName } from "../../src/endpoints.ts";
import { BINANCE_HOSTS, type Host } from "../../src/env.ts";
import { AUTH_PARAMS, type Recording } from "../../src/recording.ts";

const DIR = `${import.meta.dir}/../../__recordings__/demo`;

export type Scenario = Partial<Record<EndpointName, Recording>>;

/** Every recording of a Demo scenario, keyed by endpoint name. */
export async function loadScenario(name: string): Promise<Scenario> {
	const scenario: Scenario = {};
	for (const endpoint of Object.keys(ENDPOINTS) as EndpointName[]) {
		const file = Bun.file(`${DIR}/${name}/${endpoint}.json`);
		if (await file.exists()) scenario[endpoint] = await file.json();
	}
	return scenario;
}

function requestKey(
	host: string,
	method: string,
	path: string,
	params: [string, string][],
): string {
	return `${host} ${method} ${path}?${new URLSearchParams(params.sort()).toString()}`;
}

/**
 * A fetch that answers from recordings: host, method, path and every non-auth
 * param must match. Anything else is answered 404 and listed in `misses`, so
 * a test can assert the adapter sent nothing that was not recorded.
 */
export function replay(scenario: Scenario): {
	fetch: Fetch;
	requested: string[];
	misses: string[];
} {
	const recorded = new Map<string, Recording>();
	for (const r of Object.values(scenario)) {
		const { host, method, path, params } = r.request;
		recorded.set(requestKey(host, method, path, Object.entries(params)), r);
	}
	const hosts = BINANCE_HOSTS.demo;
	const requested: string[] = [];
	const misses: string[] = [];
	const fetch: Fetch = async (url, init) => {
		const u = new URL(url);
		const host = (Object.keys(hosts) as Host[]).find(
			(h) => new URL(hosts[h]).origin === u.origin,
		);
		const params = [...u.searchParams].filter(([k]) => !AUTH_PARAMS.has(k));
		const k = requestKey(
			host ?? u.origin,
			init.method ?? "GET",
			u.pathname,
			params,
		);
		requested.push(k);
		const r = recorded.get(k);
		if (r === undefined) {
			misses.push(k);
			return new Response("no recording", { status: 404 });
		}
		// A non-JSON body (e.g. the nginx 404 page) is stored as its text.
		const text = typeof r.body === "string" && !r.contentType.includes("json");
		return new Response(text ? (r.body as string) : JSON.stringify(r.body), {
			status: r.status,
			headers: { "content-type": r.contentType },
		});
	};
	return { fetch, requested, misses };
}
