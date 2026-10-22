import { describe, expect, test } from "bun:test";
import type { PriceRule, QtyRule } from "../src/domain.ts";
import { notional, roundPrice, roundQty } from "../src/rules.ts";

const tick = (tick: string): PriceRule => ({ kind: "tick", tick });
const sigfig = (maxDecimals: number): PriceRule => ({
	kind: "sigfig",
	sigFigs: 5,
	maxDecimals,
});
const step = (step: string): QtyRule => ({
	step,
	marketStep: step,
	minQty: step,
});

describe("roundPrice — tick", () => {
	test.each([
		["0.01", "123.456", "123.45", "123.46"],
		["0.01", "123.45", "123.45", "123.45"],
		["0.5", "9.499", "9", "9.5"],
		["10", "65432.1", "65430", "65440"],
		["0.00000001", "0.000000015", "0.00000001", "0.00000002"],
	])("tick %s, price %s → buy %s, sell %s", (t, price, buy, sell) => {
		expect(roundPrice(tick(t), price, "buy")).toBe(buy);
		expect(roundPrice(tick(t), price, "sell")).toBe(sell);
	});
});

describe("roundPrice — sigfig (5 significant figures)", () => {
	test.each([
		[6, "12345.6", "12345", "12346"],
		[6, "123456.7", "123456", "123457"],
		[6, "1.234567", "1.2345", "1.2346"],
		[6, "0.000123456", "0.000123", "0.000124"],
		[2, "0.123456", "0.12", "0.13"],
		[6, "1.2345", "1.2345", "1.2345"],
		[6, "9.99991", "9.9999", "10"],
	])("maxDecimals %d, price %s → buy %s, sell %s", (dp, price, buy, sell) => {
		expect(roundPrice(sigfig(dp), price, "buy")).toBe(buy);
		expect(roundPrice(sigfig(dp), price, "sell")).toBe(sell);
	});
});

describe("roundQty", () => {
	test.each([
		["0.001", "1.23456", "1.234"],
		["0.001", "0.0009", "0"],
		["0.001", "5", "5"],
		["1", "12.99", "12"],
		["0.00001000", "0.123456789", "0.12345"],
	])("step %s, qty %s → %s", (s, qty, result) => {
		expect(roundQty(step(s), qty)).toBe(result);
	});
});

describe("notional", () => {
	test.each([
		["0.5", "65432.10", "32716.05"],
		// 28 significant digits: a precision-20 Decimal would truncate it.
		["123456.12345678", "65432.12345678", "8077996311.5195022165279684"],
	])("%s × %s = %s", (qty, price, result) => {
		expect(notional(qty, price)).toBe(result);
	});
});

describe("rule errors", () => {
	test.each<[string, () => unknown, string]>([
		[
			"zero price",
			() => roundPrice(tick("0.01"), "0", "buy"),
			"price must be positive",
		],
		[
			"zero tick",
			() => roundPrice(tick("0"), "1", "buy"),
			"tick must be positive",
		],
		[
			"exponent price",
			() => roundPrice(tick("0.01"), "1e5", "buy"),
			'price is not a decimal string: "1e5"',
		],
		[
			"zero sigFigs",
			() =>
				roundPrice({ kind: "sigfig", sigFigs: 0, maxDecimals: 6 }, "1", "buy"),
			"sigFigs must be a positive integer",
		],
		[
			"negative qty",
			() => roundQty(step("0.001"), "-1"),
			"qty must not be negative",
		],
		["zero step", () => roundQty(step("0"), "1"), "step must be positive"],
		[
			"non-decimal notional",
			() => notional("abc", "1"),
			'qty is not a decimal string: "abc"',
		],
	])("%s", (_, call, message) => {
		expect(call).toThrow(new RangeError(message));
	});
});
