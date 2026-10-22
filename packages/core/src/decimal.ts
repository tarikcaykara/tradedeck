import { Decimal } from "decimal.js";

/**
 * The one definition of a decimal string at every boundary: optional minus,
 * digits, optional fraction. Rejects exponent notation, NaN, Infinity, hex,
 * ".5", "5.", "+1" and "" — several of which decimal.js would accept.
 */
export const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

// `times` and `minus` round to `precision` significant digits; the default of
// 20 would truncate exact products. Never `Decimal.set` the global constructor.
const D = Decimal.clone({ precision: 64 });

export function parseDecimal(name: string, value: string): Decimal {
	if (!DECIMAL_STRING.test(value)) {
		throw new RangeError(`${name} is not a decimal string: "${value}"`);
	}
	return new D(value);
}

/** Plain notation (never `1e-8`), and zero is always "0" (never "-0"). */
export function formatDecimal(d: Decimal): string {
	return d.isZero() ? "0" : d.toFixed();
}
