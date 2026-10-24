import { describe, expect, spyOn, test } from "bun:test";
import { createBinanceAdapter } from "../src/adapter.ts";
import { loadScenario, replay } from "./support/replay.ts";

const credential = { kind: "hmac", apiKey: "k", secret: "s" } as const;

describe("createBinanceAdapter", () => {
	test("every REST member uses the injected fetch and only recorded requests", async () => {
		const { fetch, misses } = replay(await loadScenario("oneway"));
		const globalFetch = spyOn(globalThis, "fetch");
		try {
			const adapter = createBinanceAdapter({
				accountId: "acc-1",
				environment: "demo",
				credential,
				fetch,
			});
			await adapter.verifyCredential();
			await adapter.loadInstruments(["spot", "linear"]);
			await adapter.fetchSnapshot();
			expect(globalFetch).toHaveBeenCalledTimes(0);
			expect(misses).toEqual([]);
		} finally {
			globalFetch.mockRestore();
		}
	});
});
