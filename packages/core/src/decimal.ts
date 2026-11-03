import { Decimal } from "decimal.js";

/** The digit bounds of a decimal string; leading and trailing zeros do not count. */
export const MAX_INTEGER_DIGITS = 20;
export const MAX_FRACTION_DIGITS = 20;

/**
 * The one definition of a decimal string at every boundary: optional minus,
 * at most 20 integer digits, an optional fraction of at most 20 digits.
 * Rejects exponent notation, NaN, Infinity, hex, ".5", "5.", "+1", "" and
 * longer values — several of which decimal.js would accept, and a longer
 * value could not stay exact below.
 */
export const DECIMAL_STRING = new RegExp(
	`^-?0*\\d{1,${MAX_INTEGER_DIGITS}}(\\.\\d{1,${MAX_FRACTION_DIGITS}}0*)?$`,
);

// An input spans at most 40 digit places, a sum or difference of two inputs
// 41, and its product with a third at most 81 significant digits: at this
// precision `plus`, `minus` and one `times` never round. decimal.js's default
// of 20 would. Never `Decimal.set` the global constructor.
const D = Decimal.clone({
	precision: 2 * (MAX_INTEGER_DIGITS + MAX_FRACTION_DIGITS) + 2,
});

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
