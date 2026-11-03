import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { websocket } from "@hono/bun";
import {
	type ServerMessage,
	ServerMessageSchema,
	StateSnapshotSchema,
} from "@tradedeck/core";
import type { Server } from "bun";
import type { Hono } from "hono";
import { createApp } from "../src/app.ts";
import { createStore, type Store } from "../src/store.ts";
import {
	BTC_PERP,
	DEMO,
	INSTRUMENTS,
	position,
	snapshot,
	T0,
} from "./fixtures.ts";

interface Running {
	url: string;
	port: number;
	store: Store;
	logs: string[];
}

let server: Server<unknown> | undefined;
const dirs: string[] = [];

afterEach(() => {
	server?.stop(true);
	server = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The real app on a random loopback port; the guard is built from that port. */
function start(staticRoot?: string): Running {
	const store = createStore();
	store.setAccounts([DEMO]);
	store.setInstruments(INSTRUMENTS);
	const logs: string[] = [];
	let app: Hono | undefined;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req, srv) =>
			app?.fetch(req, srv) ?? new Response(null, { status: 503 }),
		websocket,
	});
	const port = server.port ?? 0;
	app = createApp({
		store,
		port,
		log: (line) => logs.push(line),
		...(staticRoot === undefined ? {} : { staticRoot }),
	});
	return { url: `http://127.0.0.1:${port}`, port, store, logs };
}

const UPGRADE = {
	Upgrade: "websocket",
	Connection: "Upgrade",
	"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
	"Sec-WebSocket-Version": "13",
};

describe("loopback guard", () => {
	test("Host evil.example → 403, on every route and the WS upgrade, with no CORS header", async () => {
		const r = start();
		for (const [path, extra] of [
			["/api/state", {}],
			["/nope", {}],
			["/ws", UPGRADE],
		] as const) {
			const res = await fetch(`${r.url}${path}`, {
				headers: { Host: "evil.example", ...extra },
			});
			expect(res.status).toBe(403);
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
		}
	});

	test("Origin https://evil.example → 403, on HTTP and the WS upgrade", async () => {
		const r = start();
		for (const extra of [{}, UPGRADE]) {
			const path = "Upgrade" in extra ? "/ws" : "/api/state";
			const res = await fetch(`${r.url}${path}`, {
				headers: { Origin: "https://evil.example", ...extra },
			});
			expect(res.status).toBe(403);
		}
	});

	test("the server's own port is the only allowed one", async () => {
		const r = start();
		const other = r.port === 8790 ? 8791 : 8790;
		for (const headers of [
			{ Host: `127.0.0.1:${other}` },
			{ Origin: `http://127.0.0.1:${other}` },
		]) {
			const res = await fetch(`${r.url}/api/state`, { headers });
			expect(res.status).toBe(403);
		}
	});

	test("the allowlisted hosts and origins pass, and so does a request without Origin", async () => {
		const r = start();
		for (const headers of [
			{},
			{ Host: `localhost:${r.port}` },
			{ Origin: `http://127.0.0.1:${r.port}` },
			{ Origin: `http://localhost:${r.port}` },
			{ Origin: "http://localhost:5173" },
			{ Origin: "http://127.0.0.1:5173" },
		]) {
			const res = await fetch(`${r.url}/api/state`, { headers });
			expect(res.status).toBe(200);
		}
	});
});

describe("GET /api/state", () => {
	test("answers the store's state, valid under StateSnapshotSchema", async () => {
		const r = start();
		r.store.applySnapshot(snapshot());
		const res = await fetch(`${r.url}/api/state`);
		const body: unknown = await res.json();
		expect(StateSnapshotSchema.parse(body)).toEqual(r.store.state());
	});
});

/** Collects parsed messages; `until` resolves once `n` have arrived. */
function client(url: string) {
	const messages: ServerMessage[] = [];
	const ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
	const waiters: Array<{ n: number; resolve: () => void }> = [];
	ws.onmessage = (e) => {
		messages.push(ServerMessageSchema.parse(JSON.parse(String(e.data))));
		for (const w of [...waiters]) {
			if (messages.length >= w.n) {
				waiters.splice(waiters.indexOf(w), 1);
				w.resolve();
			}
		}
	};
	return {
		ws,
		messages,
		until(n: number): Promise<void> {
			if (messages.length >= n) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ n, resolve });
			return promise;
		},
	};
}

describe("/ws", () => {
	test("a client receives the snapshot, the latest prices, then deltas", async () => {
		const r = start();
		r.store.applySnapshot(snapshot());
		const mark = {
			instrumentId: BTC_PERP.id,
			price: "80123.4",
			kind: "mark",
			ts: T0 + 1,
		} as const;
		r.store.applyPrice(mark);
		const c = client(r.url);
		await c.until(2);
		expect(c.messages).toEqual([
			{ type: "snapshot", state: r.store.state() },
			{ type: "price", ...mark },
		]);
		r.store.applyPosition(position("0.02", T0 + 5));
		r.store.setStatus(DEMO.id, "live");
		await c.until(4);
		expect(c.messages.slice(2)).toEqual([
			{ type: "position", position: position("0.02", T0 + 5) },
			{ type: "account_status", accountId: DEMO.id, status: "live" },
		]);
		c.ws.close();
	});

	test("a message that fails the protocol schema is logged and never sent", async () => {
		const r = start();
		const c = client(r.url);
		await c.until(1);
		r.store.applyPrice({
			instrumentId: BTC_PERP.id,
			price: "-1",
			kind: "mark",
			ts: T0,
		});
		r.store.setStatus(DEMO.id, "live");
		await c.until(2);
		expect(c.messages.map((m) => m.type)).toEqual([
			"snapshot",
			"account_status",
		]);
		expect(
			r.logs.some((l) => l.startsWith("dropped an invalid price message")),
		).toBe(true);
		c.ws.close();
	});
});

describe("static files", () => {
	test("serves the built web app from staticRoot, behind the guard", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tradedeck-web-"));
		dirs.push(dir);
		writeFileSync(
			join(dir, "index.html"),
			"<!doctype html><title>tradedeck</title>",
		);
		const r = start(dir);
		const ok = await fetch(`${r.url}/`);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toContain("<title>tradedeck</title>");
		const evil = await fetch(`${r.url}/`, {
			headers: { Host: "evil.example" },
		});
		expect(evil.status).toBe(403);
	});
});
