import { VenueError } from "@tradedeck/adapter";
import type {
	AccountSnapshot,
	Balance,
	MarginMode,
	Position,
} from "@tradedeck/core";
import { z } from "zod";
import {
	abs,
	add,
	isPositive,
	isZero,
	minusFloorZero,
	venueDecimal,
} from "./decimal.ts";
import { venueEnum } from "./decode.ts";
import { ENDPOINTS } from "./endpoints.ts";
import type { BinanceHttp } from "./http.ts";
import {
	algoOrder,
	FuturesOpenOrders,
	futuresOrder,
	OpenAlgoOrders,
	positionSide,
	SpotOpenOrders,
	spotOrder,
} from "./orders.ts";

const SpotAccount = z.object({
	balances: z.array(
		z.object({ asset: z.string(), free: venueDecimal, locked: venueDecimal }),
	),
});

const FuturesBalances = z.array(
	z.object({
		asset: z.string(),
		balance: venueDecimal,
		maxWithdrawAmount: venueDecimal,
	}),
);

const PositionRisk = z.array(
	z.object({
		symbol: z.string().min(1),
		positionSide,
		positionAmt: venueDecimal,
		entryPrice: venueDecimal,
		markPrice: venueDecimal,
		unRealizedProfit: venueDecimal,
		liquidationPrice: venueDecimal,
		updateTime: z.number().int().nonnegative(),
	}),
);

const SymbolConfigs = z.array(
	z.object({
		symbol: z.string(),
		marginType: venueEnum(
			{ CROSSED: "cross", ISOLATED: "isolated" } satisfies Record<
				string,
				MarginMode
			>,
			"margin type",
		),
		leverage: z.number().int().positive(),
	}),
);

/**
 * Spot balances, futures wallet balances, futures positions and every open
 * order, conditional (algo) orders included. Any failing request fails the
 * whole snapshot: a resync replaces state and never merges (architecture §6).
 */
export async function fetchSnapshot(
	http: BinanceHttp,
	accountId: string,
	now: () => number,
): Promise<AccountSnapshot> {
	const [
		spotAccount,
		spotOrders,
		futuresBalances,
		positionRisk,
		symbolConfigs,
		futuresOrders,
		algoOrders,
	] = await Promise.all([
		http.request(ENDPOINTS.spotAccount, SpotAccount),
		http.request(ENDPOINTS.spotOpenOrders, SpotOpenOrders),
		http.request(ENDPOINTS.futuresBalance, FuturesBalances),
		http.request(ENDPOINTS.positionRisk, PositionRisk),
		http.request(ENDPOINTS.symbolConfig, SymbolConfigs),
		http.request(ENDPOINTS.futuresOpenOrders, FuturesOpenOrders),
		http.request(ENDPOINTS.openAlgoOrders, OpenAlgoOrders),
	]);

	// v3 positionRisk carries neither leverage nor margin type.
	const config = new Map(symbolConfigs.map((c) => [c.symbol, c]));
	const positions = positionRisk.flatMap((p): Position[] => {
		if (isZero(p.positionAmt)) return [];
		const c = config.get(p.symbol);
		if (c === undefined) {
			throw new VenueError({
				kind: "decode",
				method: ENDPOINTS.symbolConfig.method,
				path: ENDPOINTS.symbolConfig.path,
				status: null,
				code: null,
				retryAfterMs: null,
				text: `no symbol configuration for a position on ${p.symbol}`,
			});
		}
		return [
			{
				accountId,
				instrumentId: `binance:linear:${p.symbol}`,
				// Hedge legs carry their side; a one-way amount carries it in its sign.
				side:
					p.positionSide === "both"
						? p.positionAmt.startsWith("-")
							? "short"
							: "long"
						: p.positionSide,
				positionSide: p.positionSide,
				size: abs(p.positionAmt),
				entryPrice: p.entryPrice,
				markPrice: p.markPrice,
				liquidationPrice: isPositive(p.liquidationPrice)
					? p.liquidationPrice
					: null,
				unrealizedPnl: p.unRealizedProfit,
				leverage: c.leverage,
				marginMode: c.marginType,
				updatedAt: p.updateTime,
			},
		];
	});

	return {
		accountId,
		balances: [
			...spotAccount.balances.map(
				(b): Balance => ({
					accountId,
					scope: "spot",
					asset: b.asset,
					free: b.free,
					locked: b.locked,
					total: add(b.free, b.locked),
				}),
			),
			...futuresBalances
				.filter((b) => !(isZero(b.balance) && isZero(b.maxWithdrawAmount)))
				// `balance` is the wallet balance (uPnL excluded); what can be moved
				// out of the futures wallet is free, the rest is margin in use.
				.map(
					(b): Balance => ({
						accountId,
						scope: "derivs",
						asset: b.asset,
						free: b.maxWithdrawAmount,
						locked: minusFloorZero(b.balance, b.maxWithdrawAmount),
						total: b.balance,
					}),
				),
		],
		positions,
		openOrders: [
			...spotOrders.map((o) => spotOrder(accountId, o)),
			...futuresOrders.map((o) => futuresOrder(accountId, o)),
			...algoOrders.map((o) => algoOrder(accountId, o)),
		],
		fetchedAt: now(),
	};
}
