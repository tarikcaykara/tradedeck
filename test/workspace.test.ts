import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const ROOT = `${import.meta.dir}/..`;

const LIBRARIES = [
	"@tradedeck/adapter",
	"@tradedeck/binance",
	"@tradedeck/core",
	"@tradedeck/db",
	"@tradedeck/secrets",
] as const;

const APPS = ["@tradedeck/cli", "@tradedeck/server", "@tradedeck/web"] as const;

const VENUE_SIDE = [
	"@tradedeck/core",
	"@tradedeck/adapter",
	"@tradedeck/binance",
	"@tradedeck/db",
	"@tradedeck/secrets",
] as const;

/**
 * CLAUDE.md, "Import direction", encoded as a test so a violation fails a run
 * instead of being spotted in review.
 *
 * Two entries carry hard rules rather than mere layering:
 * - `core` maps to nothing (hard rule 8: it stays pure, with no I/O).
 * - `web` reaches only `core`: the browser never holds a credential or talks
 *   to a venue.
 *
 * No list names an app, so nothing can depend on one.
 */
const ALLOWED_INTERNAL_DEPS: Record<string, readonly string[]> = {
	"@tradedeck/core": [],
	"@tradedeck/adapter": ["@tradedeck/core"],
	"@tradedeck/binance": ["@tradedeck/adapter", "@tradedeck/core"],
	"@tradedeck/db": ["@tradedeck/core"],
	"@tradedeck/secrets": ["@tradedeck/core"],
	"@tradedeck/server": VENUE_SIDE,
	"@tradedeck/cli": VENUE_SIDE,
	"@tradedeck/web": ["@tradedeck/core"],
};

interface Manifest {
	name: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

interface Workspace {
	dir: string;
	pkg: Manifest;
}

async function workspaces(): Promise<Workspace[]> {
	const found: Workspace[] = [];
	for (const base of ["apps", "packages"]) {
		for await (const rel of new Glob("*/package.json").scan({
			cwd: `${ROOT}/${base}`,
		})) {
			const dir = `${ROOT}/${base}/${rel.replace("/package.json", "")}`;
			found.push({ dir, pkg: await Bun.file(`${dir}/package.json`).json() });
		}
	}
	return found;
}

/**
 * The dependency kinds live in exactly one place: a test that forgot
 * `peerDependencies` would keep passing while missing real violations.
 */
function internalDeps(m: Manifest): string[] {
	return Object.keys({
		...m.dependencies,
		...m.devDependencies,
		...m.peerDependencies,
	}).filter((d) => d.startsWith("@tradedeck/"));
}

/**
 * Every static, side-effect, re-export, dynamic and `require` import. A regex
 * rather than `Bun.Transpiler.scanImports`, because it also sees type-only and
 * unused imports. A match inside a comment is a false positive that fails
 * closed.
 */
const IMPORT_SPECIFIER =
	/\b(?:import|export)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g;

function importSpecifiers(source: string): string[] {
	return [...source.matchAll(IMPORT_SPECIFIER)].flatMap((m) => {
		const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
		return spec === undefined ? [] : [spec];
	});
}

describe("workspace layout", () => {
	test("every workspace in the documented layout is present", async () => {
		const names = (await workspaces()).map((w) => w.pkg.name).sort();
		expect(names).toEqual([...APPS, ...LIBRARIES].sort());
	});

	test("every declared edge resolves from its consumer", async () => {
		const unresolved: Record<string, string[]> = {};
		for (const { dir, pkg } of await workspaces()) {
			const broken = internalDeps(pkg).filter((dep) => {
				try {
					Bun.resolveSync(dep, dir);
					return false;
				} catch {
					return true;
				}
			});
			if (broken.length > 0) unresolved[pkg.name] = broken;
		}
		expect(unresolved).toEqual({});
	});
});

describe("import direction", () => {
	test("every workspace appears in the documented import graph", async () => {
		const missing = (await workspaces())
			.map((w) => w.pkg.name)
			.filter((n) => !Object.hasOwn(ALLOWED_INTERNAL_DEPS, n));
		expect(missing).toEqual([]);
	});

	test("no workspace depends outside its allowed set", async () => {
		const violations: Record<string, string[]> = {};
		for (const { pkg } of await workspaces()) {
			const allowed = ALLOWED_INTERNAL_DEPS[pkg.name] ?? [];
			const forbidden = internalDeps(pkg).filter((d) => !allowed.includes(d));
			if (forbidden.length > 0) violations[pkg.name] = forbidden;
		}
		expect(violations).toEqual({});
	});
});

describe("pure core (hard rule 8)", () => {
	test("the import scanner sees every import form", () => {
		const source = `
import { a } from "x1";
import {
	b,
	c,
} from "x2";
import type { T } from "x3";
import "x4";
export * from "x5";
export { d } from "x6";
await import("x7");
require("x8");
`;
		expect(importSpecifiers(source).sort()).toEqual([
			"x1",
			"x2",
			"x3",
			"x4",
			"x5",
			"x6",
			"x7",
			"x8",
		]);
	});

	test("nothing under packages/core/src imports bun, bun:* or node:*", async () => {
		const coreSrc = `${ROOT}/packages/core/src`;
		const offenders: Record<string, string[]> = {};
		let scanned = 0;
		for await (const rel of new Glob("**/*.{ts,tsx}").scan({ cwd: coreSrc })) {
			scanned++;
			const runtime = importSpecifiers(
				await Bun.file(`${coreSrc}/${rel}`).text(),
			).filter(
				(s) => s === "bun" || s.startsWith("bun:") || s.startsWith("node:"),
			);
			if (runtime.length > 0) offenders[rel] = runtime;
		}
		// A wrong path must not pass vacuously.
		expect(scanned).toBeGreaterThan(0);
		expect(offenders).toEqual({});
	});
});
