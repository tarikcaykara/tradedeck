import { parseArgs } from "node:util";
import { EnvironmentSchema, VenueSchema } from "@tradedeck/core";
import { type DoctorDeps, runDoctor } from "./doctor.ts";
import type { Io } from "./io.ts";
import {
	type KeysAddArgs,
	type KeysDeps,
	keysAdd,
	keysList,
	keysRemove,
} from "./keys.ts";
import { message } from "./redact.ts";

export const USAGE = [
	"Usage:",
	"  bun run cli -- keys add --venue binance --env live|demo --label <label> [--kind hmac]",
	"  bun run cli -- keys list",
	"  bun run cli -- keys remove <label>",
	"  bun run cli -- doctor",
].join("\n");

/**
 * Checked at `keys add` only: a label stored before the rule existed must
 * stay removable.
 */
const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

type Command =
	| { name: "add"; args: KeysAddArgs }
	| { name: "list" }
	| { name: "remove"; label: string }
	| { name: "doctor" };

/** Opened only for a command that can run; tests count the calls. */
export interface CliDeps {
	keys(): KeysDeps;
	doctor(): DoctorDeps;
}

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
	if (group === "doctor") {
		const flags = Object.values(values).some((v) => v !== undefined);
		return name === undefined && !flags
			? { name: "doctor" }
			: "doctor takes no arguments";
	}
	if (group !== "keys") return "Unknown command.";
	if (name === "add" && rest.length === 0) {
		const venue = VenueSchema.safeParse(values.venue);
		if (!venue.success) return "--venue must be binance";
		const environment = EnvironmentSchema.safeParse(values.env);
		if (!environment.success) return "--env must be live or demo";
		const label = values.label?.trim() ?? "";
		if (!LABEL_PATTERN.test(label)) {
			return '--label must be 1–64 letters, digits, ".", "_" or "-"';
		}
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
 * Returns the exit code. A factory in `deps` is called only for a valid
 * command that can run here: neither a usage error nor a missing terminal opens
 * the database or the keychain.
 */
export async function runCli(
	argv: string[],
	io: Io,
	deps: CliDeps,
): Promise<number> {
	const command = parse(argv);
	if (typeof command === "string") {
		io.error(command);
		io.print(USAGE);
		return 1;
	}
	// add and remove prompt, and a prompt at EOF never settles.
	if (
		(command.name === "add" || command.name === "remove") &&
		!io.interactive
	) {
		io.error(`keys ${command.name} needs a terminal: stdin is not a TTY`);
		return 1;
	}
	if (command.name === "doctor") {
		try {
			return await runDoctor(deps.doctor());
		} catch (e) {
			io.error(message(e));
			return 1;
		}
	}
	let d: KeysDeps | undefined;
	try {
		d = deps.keys();
		if (command.name === "add") return await keysAdd(d, command.args);
		if (command.name === "list") return keysList(d);
		return await keysRemove(d, command.label);
	} catch (e) {
		io.error(message(e));
		return 1;
	} finally {
		d?.db.$client.close();
	}
}
