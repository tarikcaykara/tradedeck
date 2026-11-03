/**
 * `GET /api/state` and `/ws` (docs/architecture.md §7), behind the loopback
 * guard. Every message is checked with the core protocol schema before it
 * leaves; one that fails is logged and never sent.
 */
import { serveStatic, upgradeWebSocket } from "@hono/bun";
import {
	type ServerMessage,
	ServerMessageSchema,
	StateSnapshotSchema,
} from "@tradedeck/core";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { loopbackGuard } from "./guard.ts";
import type { Store } from "./store.ts";

export function createApp(opts: {
	store: Store;
	/** The port the server listens on; the guard allows only it. */
	port: number;
	log: (line: string) => void;
	/** The built web app (`apps/web/dist`); not served when absent. */
	staticRoot?: string;
}): Hono {
	const { store, log } = opts;
	const app = new Hono();
	app.use("*", loopbackGuard(opts.port));

	/** The message as JSON, or null when it fails the schema (logged, not sent). */
	function encode(message: ServerMessage): string | null {
		const checked = ServerMessageSchema.safeParse(message);
		if (checked.success) return JSON.stringify(checked.data);
		const issue = checked.error.issues[0];
		log(
			`dropped an invalid ${message.type} message: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`,
		);
		return null;
	}

	app.get("/api/state", (c) => {
		const checked = StateSnapshotSchema.safeParse(store.state());
		if (checked.success) return c.json(checked.data);
		log(`state failed its schema: ${checked.error.issues[0]?.message ?? ""}`);
		return c.text("state unavailable", 500);
	});

	app.get(
		"/ws",
		upgradeWebSocket(() => {
			let unsubscribe: (() => void) | null = null;
			const send = (ws: WSContext, message: ServerMessage) => {
				const text = encode(message);
				if (text !== null) ws.send(text);
			};
			return {
				onOpen(_, ws) {
					send(ws, { type: "snapshot", state: store.state() });
					for (const p of store.prices()) send(ws, { type: "price", ...p });
					unsubscribe = store.subscribe((m) => send(ws, m));
				},
				onClose() {
					unsubscribe?.();
					unsubscribe = null;
				},
			};
		}),
	);

	if (opts.staticRoot !== undefined) {
		app.use("/*", serveStatic({ root: opts.staticRoot }));
	}
	return app;
}
