import { describe, expect, test } from "bun:test";
import { createBinanceAdapter } from "../src/adapter.ts";

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
