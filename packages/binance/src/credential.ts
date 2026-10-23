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

const AccountFlags = z.object({
	canTrade: z.boolean(),
	canWithdraw: z.boolean(),
});

/**
 * Live: the key's own permissions (`/sapi/v1/account/apiRestrictions`,
 * mapping in architecture §5). A missing `enableWithdrawals` counts as
 * granted, so `keys add` refuses the key rather than guessing (hard rule 2).
 *
 * Demo serves no `/sapi` (404), so its report comes from the spot account and
 * the futures account configuration: a successful signed read proves
 * `canRead`, and an IP restriction cannot be observed there.
 */
export async function verifyCredential(
	http: BinanceHttp,
	environment: Environment,
): Promise<CredentialReport> {
	if (environment === "live") {
		const r = await http.get(ENDPOINTS.apiRestrictions, ApiRestrictions);
		return {
			canRead: r.enableReading ?? false,
			canTradeSpot: r.enableSpotAndMarginTrading ?? false,
			canTradeDerivs: r.enableFutures ?? false,
			canWithdraw: r.enableWithdrawals ?? true,
			ipRestricted: r.ipRestrict ?? false,
		};
	}
	const [spot, futures] = await Promise.all([
		http.get(ENDPOINTS.spotAccount, AccountFlags),
		http.get(ENDPOINTS.accountConfig, AccountFlags),
	]);
	return {
		canRead: true,
		canTradeSpot: spot.canTrade,
		canTradeDerivs: futures.canTrade,
		canWithdraw: spot.canWithdraw || futures.canWithdraw,
		ipRestricted: false,
	};
}
