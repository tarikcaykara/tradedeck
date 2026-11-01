import { parseArgs } from "node:util";
import { EnvironmentSchema, VenueSchema } from "@tradedeck/core";
import type { Io } from "./io.ts";
import {
	type KeysAddArgs,
	type KeysDeps,
	keysAdd,
	keysList,
	keysRemove,
} from "./keys.ts";

export const USAGE = [
	"Usage:",
	"  bun run cli -- keys add --venue binance --env live|demo --label <label> [--kind hmac]",
	"  bun run cli -- keys list",
	"  bun run cli -- keys remove <label>",
].join("\n");

type Command =
	| { name: "add"; args: KeysAddArgs }
	| { name: "list" }
	| { name: "remove"; label: string };

interface Flags {
	venue?: string;
	env?: string;
	label?: string;
	kind?: string;
}

/** A command, or the reason argv is not one. Argv never holds key material. */
function parse(argv: string[]): Command | string {
	let values: Flags;
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args: argv,
			options: {
				venue: { type: "string" },
				env: { type: "string" },
				label: { type: "string" },
				kind: { type: "string" },
			},
			allowPositionals: true,
			strict: true,
		}));
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
	const [group, name, ...rest] = positionals;
	if (group !== "keys") return "Unknown command.";
	if (name === "add" && rest.length === 0) {
		const venue = VenueSchema.safeParse(values.venue);
		if (!venue.success) return "--venue must be binance";
		const environment = EnvironmentSchema.safeParse(values.env);
		if (!environment.success) return "--env must be live or demo";
		const label = values.label?.trim() ?? "";
		if (label === "") return "--label is required";
		const kind = values.kind ?? "ed25519";
		if (kind !== "ed25519" && kind !== "hmac") {
			return "--kind must be ed25519 or hmac";
		}
		return {
			name: "add",
			args: {
				venue: venue.data,
				environment: environment.data,
				label,
				kind,
			},
		};
	}
	if (name === "list" && rest.length === 0) return { name: "list" };
	if (name === "remove") {
		const label = rest.length === 1 ? (rest[0]?.trim() ?? "") : "";
		return label === ""
			? "keys remove takes one label"
			: { name: "remove", label };
	}
	return "Unknown command.";
}

/**
 * Returns the exit code. `deps` is called only for a valid command, so a usage
 * error opens neither the database nor the keychain.
 */
export async function runCli(
	argv: string[],
	io: Io,
	deps: () => KeysDeps,
): Promise<number> {
	const command = parse(argv);
	if (typeof command === "string") {
		io.error(command);
		io.print(USAGE);
		return 1;
	}
	let d: KeysDeps | undefined;
	try {
		d = deps();
		if (command.name === "add") return await keysAdd(d, command.args);
		if (command.name === "list") return keysList(d);
		return await keysRemove(d, command.label);
	} catch (e) {
		io.error(e instanceof Error ? e.message : String(e));
		return 1;
	} finally {
		d?.db.$client.close();
	}
}
