import type { CredentialReport, Environment } from "@tradedeck/core";
import { z } from "zod";
import { ENDPOINTS } from "./endpoints.ts";
import type { BinanceHttp } from "./http.ts";

// Every field is optional in Binance's own connector types.
const ApiRestrictions = z.object({
	ipRestrict: z.boolean().optional(),
	enableReading: z.boolean().optional(),
	enableWithdrawals: z.boolean().optional(),
	enableSpotAndMarginTrading: z.boolean().optional(),
	enableFutures: z.boolean().optional(),
});

const AccountFlags = z.object({ canTrade: z.boolean() });

/**
 * Live: the key's own permissions (`/sapi/v1/account/apiRestrictions`,
 * mapping in architecture §5). A missing `enableWithdrawals` counts as
 * granted, so `keys add` refuses the key rather than guessing (hard rule 2).
 *
 * Demo serves no `/sapi` (404), so its report comes from the spot account and
 * the futures account configuration: a successful signed read proves
 * `canRead`, and an IP restriction cannot be observed there. Their
 * `canWithdraw` is an account flag (Demo answers `true`), not a key
 * permission: Demo keys offer no withdrawal permission and Demo funds are not
 * real, so Demo reports `canWithdraw: false` (docs/decisions.md).
 */
export async function verifyCredential(
	http: BinanceHttp,
	environment: Environment,
): Promise<CredentialReport> {
	if (environment === "live") {
		const r = await http.request(ENDPOINTS.apiRestrictions, ApiRestrictions);
		return {
			canRead: r.enableReading ?? false,
			canTradeSpot: r.enableSpotAndMarginTrading ?? false,
			canTradeDerivs: r.enableFutures ?? false,
			canWithdraw: r.enableWithdrawals ?? true,
			ipRestricted: r.ipRestrict ?? false,
		};
	}
	const [spot, futures] = await Promise.all([
		http.request(ENDPOINTS.spotAccount, AccountFlags),
		http.request(ENDPOINTS.accountConfig, AccountFlags),
	]);
	return {
		canRead: true,
		canTradeSpot: spot.canTrade,
		canTradeDerivs: futures.canTrade,
		canWithdraw: false,
		ipRestricted: false,
	};
}
