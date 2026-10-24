import { describe, expect, test } from "bun:test";
import { VenueError } from "@tradedeck/adapter";
import { createBinanceAdapter } from "../src/adapter.ts";
import { loadScenario, replay, type Scenario } from "./support/replay.ts";

const credential = { kind: "hmac", apiKey: "k", secret: "s" } as const;

/**
 * Live answers from Binance's documented response shape: live is never
 * called, and Demo serves no `/sapi` to record.
 */
function live(restrictions: unknown) {
	const paths: string[] = [];
	const adapter = createBinanceAdapter({
		accountId: "acc-1",
		environment: "live",
		credential,
		fetch: async (url) => {
			const { pathname } = new URL(url);
			paths.push(pathname);
			if (pathname === "/api/v3/time") {
				return Response.json({ serverTime: 1_700_000_000_000 });
			}
			return Response.json(restrictions);
		},
		now: () => 1_700_000_000_000,
	});
	return { adapter, paths };
}

// Field set of Binance's "Get API Key Permission" (docs/venues/binance.md).
const READ_ONLY = {
	ipRestrict: false,
	createTime: 1698645219000,
	enableReading: true,
	enableWithdrawals: false,
	enableInternalTransfer: false,
	enableMargin: false,
	enableFutures: false,
	permitsUniversalTransfer: false,
	enableVanillaOptions: false,
	enableFixApiTrade: false,
	enableFixReadOnly: true,
	enableSpotAndMarginTrading: false,
	enablePortfolioMarginTrading: false,
};

describe("verifyCredential — live", () => {
	test("maps apiRestrictions per architecture §5", async () => {
		const { adapter, paths } = live({
			...READ_ONLY,
			ipRestrict: true,
			enableSpotAndMarginTrading: true,
			enableFutures: true,
		});
		expect(await adapter.verifyCredential()).toEqual({
			canRead: true,
			canTradeSpot: true,
			canTradeDerivs: true,
			canWithdraw: false,
			ipRestricted: true,
		});
		expect(paths).toEqual(["/api/v3/time", "/sapi/v1/account/apiRestrictions"]);
	});

	test("reports withdrawal permission", async () => {
		const { adapter } = live({ ...READ_ONLY, enableWithdrawals: true });
		expect((await adapter.verifyCredential()).canWithdraw).toBe(true);
	});

	test("a missing enableWithdrawals counts as granted, so the key is refused", async () => {
		const { enableWithdrawals: _, ...rest } = READ_ONLY;
		const { adapter } = live(rest);
		expect(await adapter.verifyCredential()).toEqual({
			canRead: true,
			canTradeSpot: false,
			canTradeDerivs: false,
			canWithdraw: true,
			ipRestricted: false,
		});
	});

	test("missing permission flags count as not granted", async () => {
		const { adapter } = live({ enableWithdrawals: false });
		expect(await adapter.verifyCredential()).toEqual({
			canRead: false,
			canTradeSpot: false,
			canTradeDerivs: false,
			canWithdraw: false,
			ipRestricted: false,
		});
	});
});

function demo(scenario: Scenario) {
	const r = replay(scenario);
	const adapter = createBinanceAdapter({
		accountId: "acc-1",
		environment: "demo",
		credential,
		fetch: r.fetch,
	});
	return { adapter, ...r };
}

interface AccountFlags {
	canTrade: boolean;
	canWithdraw: boolean;
}

/** The recorded account flags of one endpoint, mutable in a cloned scenario. */
function flags(
	scenario: Scenario,
	name: "spotAccount" | "accountConfig",
): AccountFlags {
	const recording = scenario[name];
	if (recording === undefined) throw new Error(`no ${name} recording`);
	return recording.body as AccountFlags;
}

describe("verifyCredential — Demo (recorded)", () => {
	test("reads the spot account and futures config, never /sapi, and reports no withdrawal", async () => {
		const scenario = await loadScenario("oneway");
		// Demo's account-level flag, not a key permission (docs/decisions.md).
		expect(flags(scenario, "spotAccount").canWithdraw).toBe(true);
		expect(flags(scenario, "accountConfig").canWithdraw).toBe(true);
		const { adapter, requested, misses } = demo(scenario);
		expect(await adapter.verifyCredential()).toEqual({
			canRead: true,
			canTradeSpot: true,
			canTradeDerivs: true,
			canWithdraw: false,
			ipRestricted: false,
		});
		expect(requested.filter((r) => r.includes("/sapi/"))).toEqual([]);
		expect(misses).toEqual([]);
	});

	test("trade flags come from the spot account and the futures config respectively", async () => {
		const scenario = structuredClone(await loadScenario("oneway"));
		flags(scenario, "spotAccount").canTrade = false;
		const { adapter } = demo(scenario);
		expect(await adapter.verifyCredential()).toMatchObject({
			canTradeSpot: false,
			canTradeDerivs: true,
		});
	});

	test("a rejected signed read is not reported as readable", async () => {
		const scenario = structuredClone(await loadScenario("oneway"));
		const accountConfig = scenario.accountConfig;
		if (accountConfig === undefined) throw new Error("no accountConfig");
		scenario.accountConfig = {
			...accountConfig,
			status: 401,
			body: {
				code: -2015,
				msg: "Invalid API-key, IP, or permissions for action.",
			},
		};
		const { adapter } = demo(scenario);
		await expect(adapter.verifyCredential()).rejects.toBeInstanceOf(VenueError);
	});
});
