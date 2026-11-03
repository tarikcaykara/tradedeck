import { describe, expect, test } from "bun:test";
import { parseDecimal } from "../src/decimal.ts";
import { unrealizedPnl } from "../src/pnl.ts";
import { notional } from "../src/rules.ts";

/** 20 integer and 20 fraction digits: the largest decimal string. */
const MAX = "99999999999999999999.99999999999999999999";

describe("parseDecimal", () => {
	test.each([
		["21 integer digits", "100000000000000000000"],
		["21 fraction digits", "0.000000000000000000001"],
		["a negative with 21 integer digits", "-123456789012345678901"],
	])("rejects %s instead of rounding it", (_, value) => {
		expect(() => parseDecimal("qty", value)).toThrow(
			new RangeError(`qty is not a decimal string: "${value}"`),
		);
	});

	test.each([
		[MAX, MAX],
		[`-${MAX}`, `-${MAX}`],
		[
			"leading and trailing zeros",
			"0000000000000000000000001.1000000000000000000000000",
		],
	])("accepts %s", (_, value) => {
		expect(() => parseDecimal("qty", value)).not.toThrow();
	});
});

// Python's decimal at 200 digits gives the expected values.
describe("arithmetic is exact at the digit bounds", () => {
	test("unrealizedPnl: a difference of two inputs times a third", () => {
		expect(
			unrealizedPnl({
				side: "long",
				size: MAX,
				entryPrice: "0.00000000000000000001",
				markPrice: MAX,
			}),
		).toBe(
			"9999999999999999999999999999999999999997.0000000000000000000000000000000000000002",
		);
	});

	test("notional: a product of two inputs", () => {
		expect(notional(MAX, MAX)).toBe(
			"9999999999999999999999999999999999999998.0000000000000000000000000000000000000001",
		);
	});
});
