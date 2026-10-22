import { Decimal } from "decimal.js";
import { formatDecimal, parseDecimal } from "./decimal.ts";
import type { OrderSide, PriceRule, QtyRule } from "./domain.ts";

/**
 * Rounds a positive price onto the instrument's price grid: buy rounds down,
 * sell rounds up, so the user never pays more or receives less than typed.
 * Throws if a buy price below the first grid step would round to zero.
 */
export function roundPrice(
	rule: PriceRule,
	price: string,
	side: OrderSide,
): string {
	const p = parseDecimal("price", price);
	if (p.lte(0)) throw new RangeError("price must be positive");
	const rm = side === "buy" ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL;
	const rounded = toPriceGrid(rule, p, rm);
	if (rounded.isZero()) throw new RangeError("price rounds to zero");
	return formatDecimal(rounded);
}

function toPriceGrid(
	rule: PriceRule,
	p: Decimal,
	rm: Decimal.Rounding,
): Decimal {
	switch (rule.kind) {
		case "tick": {
			const t = parseDecimal("tick", rule.tick);
			if (t.lte(0)) throw new RangeError("tick must be positive");
			// `toNearest` ignores `precision`, so the result is exact.
			return p.toNearest(t, rm);
		}
		case "sigfig": {
			const { sigFigs, maxDecimals } = rule;
			if (!Number.isInteger(sigFigs) || sigFigs < 1) {
				throw new RangeError("sigFigs must be a positive integer");
			}
			if (!Number.isInteger(maxDecimals) || maxDecimals < 0) {
				throw new RangeError("maxDecimals must be a non-negative integer");
			}
			// Hyperliquid: at most `sigFigs` significant figures and `maxDecimals`
			// decimals; integers are always valid. Within one exponent band the
			// valid grid is 10^-dp (`p.e`: 0.123 → -1, 12345.67 → 4), and crossing
			// into the next band only lowers the figures needed. Clamping at 0
			// keeps integer prices valid.
			const dp = Math.max(0, Math.min(maxDecimals, sigFigs - 1 - p.e));
			return p.toDecimalPlaces(dp, rm);
		}
	}
}

/** Rounds a quantity DOWN to the rule's `step`; never up. */
export function roundQty(rule: QtyRule, qty: string): string {
	const q = parseDecimal("qty", qty);
	if (q.lt(0)) throw new RangeError("qty must not be negative");
	const s = parseDecimal("step", rule.step);
	if (s.lte(0)) throw new RangeError("step must be positive");
	return formatDecimal(q.toNearest(s, Decimal.ROUND_DOWN));
}

/** `qty × price`, unrounded: exact up to 64 significant digits. */
export function notional(qty: string, price: string): string {
	return formatDecimal(
		parseDecimal("qty", qty).times(parseDecimal("price", price)),
	);
}
