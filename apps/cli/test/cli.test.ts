import { describe, expect, test } from "bun:test";
import { type CliDeps, runCli, USAGE } from "../src/cli.ts";
import { fakeIo } from "./support/io.ts";

/** Factories that count their calls and throw: shows whether a command got as far as opening anything. */
function counting(): {
	deps: CliDeps;
	opened: { keys: number; doctor: number };
} {
	const opened = { keys: 0, doctor: 0 };
	return {
		opened,
		deps: {
			keys: () => {
				opened.keys++;
				throw new Error("opened");
			},
			doctor: () => {
				opened.doctor++;
				throw new Error("opened");
			},
		},
	};
}

const add = (label: string) => [
	"keys",
	"add",
	"--venue",
	"binance",
	"--env",
	"demo",
	"--label",
	label,
];

describe("runCli", () => {
	test.each<[string[]]>([
		[["keys", "add", "--venue", "binance", "--env", "prod", "--label", "x"]],
		[["keys", "add", "--venue", "binance", "--env", "demo"]],
		[add("bad\u001b[31m")],
		[add("two words")],
		[add("a".repeat(65))],
		[["keys", "remove"]],
		[["keys", "frobnicate"]],
		[["doctor", "now"]],
		[["doctor", "--label", "x"]],
		[[]],
	])("rejects %p with the usage and opens nothing", async (argv) => {
		const { io, out } = fakeIo();
		const c = counting();
		const exit = await runCli(argv, io, c.deps);
		expect(exit).toBe(1);
		expect(c.opened).toEqual({ keys: 0, doctor: 0 });
		expect(out).toContain(USAGE);
	});

	test("a missing label names the label rule", async () => {
		const { io, out } = fakeIo();
		await runCli(
			["keys", "add", "--venue", "binance", "--env", "demo"],
			io,
			counting().deps,
		);
		expect(out).toContain(
			'--label must be 1–64 letters, digits, ".", "_" or "-"',
		);
	});

	test.each(["binance-demo", "Main_2.live", "a".repeat(64)])(
		"accepts label %p",
		async (label) => {
			const { io } = fakeIo();
			const c = counting();
			await runCli(add(label), io, c.deps);
			expect(c.opened).toEqual({ keys: 1, doctor: 0 });
		},
	);

	test.each<[string, string[]]>([
		["add", add("x")],
		["remove", ["keys", "remove", "x"]],
	])(
		"keys %s without a terminal is refused and opens nothing",
		async (name, argv) => {
			const { io, out } = fakeIo([], false);
			const c = counting();
			const exit = await runCli(argv, io, c.deps);
			expect(exit).toBe(1);
			expect(c.opened).toEqual({ keys: 0, doctor: 0 });
			expect(out).toContain(
				`keys ${name} needs a terminal: stdin is not a TTY`,
			);
			expect(out).not.toContain(USAGE);
		},
	);

	test.each<[string, string[], { keys: number; doctor: number }]>([
		["keys list", ["keys", "list"], { keys: 1, doctor: 0 }],
		["doctor", ["doctor"], { keys: 0, doctor: 1 }],
	])("%s runs without a terminal", async (_, argv, opened) => {
		const { io } = fakeIo([], false);
		const c = counting();
		await runCli(argv, io, c.deps);
		expect(c.opened).toEqual(opened);
	});
});
