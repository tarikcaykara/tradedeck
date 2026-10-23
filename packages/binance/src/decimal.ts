import { DecimalStringSchema } from "@tradedeck/core";
import { Decimal } from "decimal.js";
import { z } from "zod";

// Sums and differences of venue amounts; 64 digits so nothing is rounded.
// Never `Decimal.set` the global constructor.
const D = Decimal.clone({ precision: 64 });

const EXPONENT = /^-?\d+(\.\d+)?[eE][-+]?\d+$/;

/** Plain notation, and zero is always "0" (never "-0"). */
const plain = (d: Decimal): string => (d.isZero() ? "0" : d.toFixed());

/**
 * A venue decimal string. Plain decimals pass unchanged; exponent notation
 * (`1E-8`) becomes plain notation, because core decimals have no exponent
 * (decision 2026-10-22); anything else is a decode error.
 */
export const venueDecimal = z.string().transform((s, ctx) => {
	if (DecimalStringSchema.safeParse(s).success) return s;
	if (EXPONENT.test(s)) return plain(new D(s));
	ctx.addIssue({ code: "custom", message: "not a decimal string" });
	return z.NEVER;
});

export function add(a: string, b: string): string {
	return plain(new D(a).plus(b));
}

/** `a − b`, or "0" when that is negative. */
export function minusFloorZero(a: string, b: string): string {
	const d = new D(a).minus(b);
	return d.isNegative() ? "0" : plain(d);
}

export function abs(a: string): string {
	return plain(new D(a).abs());
}

export function isZero(a: string): boolean {
	return new D(a).isZero();
}

/** True when `a` is positive; `"0"` and negatives are false. */
export function isPositive(a: string): boolean {
	return new D(a).isPositive() && !new D(a).isZero();
}
