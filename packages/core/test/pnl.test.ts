import { expect, test } from "bun:test";
import { unrealizedPnl } from "../src/pnl.ts";

test.each<["long" | "short", string, string, string, string]>([
	["long", "65000", "65500.5", "0.01", "5.005"],
	["short", "65000", "65500.5", "0.01", "-5.005"],
	["short", "3000", "2950.25", "2", "99.5"],
	["long", "100", "100", "3", "0"],
	["long", "100", "90", "0", "0"],
])(
	"%s entry %s, mark %s, size %s → %s",
	(side, entryPrice, markPrice, size, result) => {
		expect(unrealizedPnl({ side, entryPrice, markPrice, size })).toBe(result);
	},
);

test("a negative size is rejected, not sign-flipped", () => {
	expect(() =>
		unrealizedPnl({
			side: "short",
			entryPrice: "3000",
			markPrice: "2950.25",
			size: "-2",
		}),
	).toThrow(new RangeError("size must not be negative"));
});
