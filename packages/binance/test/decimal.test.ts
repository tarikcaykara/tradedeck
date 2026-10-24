import { describe, expect, test } from "bun:test";
import {
	add,
	isPositive,
	minusFloorZero,
	venueDecimal,
} from "../src/decimal.ts";

describe("venueDecimal", () => {
	test.each([
		["0.00000000", "0.00000000"],
		["-1.5", "-1.5"],
		["1E-8", "0.00000001"],
		["1.5e-7", "0.00000015"],
		["2.5E+3", "2500"],
		["-0e5", "0"],
	])("%s → %s", (input, output) => {
		expect(venueDecimal.parse(input)).toBe(output);
	});

	test.each(["", "abc", ".5", "5.", "+1", "NaN", "Infinity", "0x10"])(
		"rejects %p",
		(input) => {
			expect(venueDecimal.safeParse(input).success).toBe(false);
		},
	);
});

describe("arithmetic", () => {
	test("add is exact beyond JS-number precision", () => {
		expect(add("0.10000000", "0.20000000")).toBe("0.3");
		expect(add("12345678901234567890.12345678", "0.00000001")).toBe(
			"12345678901234567890.12345679",
		);
	});

	test("minusFloorZero clamps a negative difference to 0", () => {
		expect(minusFloorZero("100", "40.5")).toBe("59.5");
		expect(minusFloorZero("100", "100")).toBe("0");
		expect(minusFloorZero("100", "120")).toBe("0");
	});

	test("isPositive is false for zero and negatives", () => {
		expect(isPositive("0.00000000")).toBe(false);
		expect(isPositive("-1")).toBe(false);
		expect(isPositive("0.00000001")).toBe(true);
	});
});
