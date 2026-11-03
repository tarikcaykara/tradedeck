/**
 * `bun run server` (docs/architecture.md §3): the only long-running process
 * that holds credentials. It binds 127.0.0.1:8790 alone; the loopback guard
 * refuses every other `Host` and `Origin` (hard rule 3).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { websocket } from "@hono/bun";
import { createBinanceAdapter } from "@tradedeck/binance";
import { listAccounts, openDb } from "@tradedeck/db";
import { createKeychainSecretStore } from "@tradedeck/secrets";
import { createApp } from "./app.ts";
import { startSessions } from "./sessions.ts";
import { createStore } from "./store.ts";

const HOSTNAME = "127.0.0.1";
const PORT = 8790;
const WEB_DIST = join(import.meta.dir, "..", "..", "web", "dist");

const log = (line: string) =>
	console.log(`${new Date().toISOString()} ${line}`);

const db = openDb();
const accounts = listAccounts(db);
db.$client.close();

const store = createStore();
store.setAccounts(accounts);
const sessions = startSessions({
	accounts,
	secrets: createKeychainSecretStore(),
	adapterFor: (account, credential) =>
		createBinanceAdapter({
			accountId: account.id,
			environment: account.environment,
			credential,
		}),
	store,
	log,
});

const app = createApp({
	store,
	port: PORT,
	log,
	...(existsSync(WEB_DIST) ? { staticRoot: WEB_DIST } : {}),
});
const server = Bun.serve({
	hostname: HOSTNAME,
	port: PORT,
	fetch: (req, srv) => app.fetch(req, srv),
	websocket,
});
log(
	`listening on http://${HOSTNAME}:${PORT} with ${accounts.length} account(s)`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		log(`${signal}: stopping`);
		sessions.stop();
		void server.stop();
		process.exit(0);
	});
}
