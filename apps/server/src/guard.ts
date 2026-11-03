import type { MiddlewareHandler } from "hono";

/** The Vite dev server's origins (docs/architecture.md §3). */
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/**
 * Hard rule 3, in front of every route including the WebSocket upgrade: 403
 * unless `Host` names this server on loopback and `Origin`, when present, is
 * this server or the Vite dev server. The DNS-rebinding and CSRF defence of a
 * local API: a hostile page can make the browser reach 127.0.0.1, but it
 * cannot forge the `Host` it was loaded under or the `Origin` the browser
 * attaches. No CORS header is ever sent.
 */
export function loopbackGuard(port: number): MiddlewareHandler {
	const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	const origins = new Set([
		`http://127.0.0.1:${port}`,
		`http://localhost:${port}`,
		...DEV_ORIGINS,
	]);
	return async (c, next) => {
		const host = c.req.header("host");
		const origin = c.req.header("origin");
		if (host === undefined || !hosts.has(host)) return c.text("forbidden", 403);
		if (origin !== undefined && !origins.has(origin)) {
			return c.text("forbidden", 403);
		}
		return next();
	};
}
