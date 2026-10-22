import { formatDecimal, parseDecimal } from "./decimal.ts";
import type { Position } from "./domain.ts";

/**
 * Long `(mark − entry) × size`, short `(entry − mark) × size`. On a mark tick:
 * `unrealizedPnl({ ...position, markPrice })`.
 */
export function unrealizedPnl(
	position: Pick<Position, "side" | "size" | "entryPrice" | "markPrice">,
): string {
	const entry = parseDecimal("entryPrice", position.entryPrice);
	const mark = parseDecimal("markPrice", position.markPrice);
	const size = parseDecimal("size", position.size);
	// A negative size would silently flip the sign of the result.
	if (size.isNegative()) throw new RangeError("size must not be negative");
	const perUnit =
		position.side === "long" ? mark.minus(entry) : entry.minus(mark);
	return formatDecimal(perUnit.times(size));
}
