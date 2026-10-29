import type { Fetch } from "@tradedeck/adapter";
import {
	type AccountSnapshot,
	AccountSnapshotSchema,
	type AccountStatus,
	type Balance,
	BalanceSchema,
	type Fill,
	FillSchema,
	type Order,
	OrderSchema,
	type Position,
	PositionSchema,
} from "@tradedeck/core";
import { createBinanceAdapter } from "../../src/adapter.ts";
import { AUTH_PARAMS } from "../../src/recording.ts";
import { type ManualClock, manualClock } from "./clock.ts";
import {
	type FakeSocket,
	type FakeWebSockets,
	fakeWebSockets,
} from "./fake-ws.ts";
import { loadScenario, replay, type Scenario } from "./replay.ts";
import { until } from "./wait.ts";

export const SPOT_URL = "wss://demo-ws-api.binance.com/ws-api/v3";
export const FUTURES_URL = "wss://demo-fstream.binance.com/private/ws/";

/** One handler call; `invalid` is an emitted object its strict core schema rejected. */
export type Call =
	| ["snapshot", AccountSnapshot]
	| ["balance", Balance]
	| ["position", Position]
	| ["order", Order]
	| ["fill", Fill]
	| ["status", AccountStatus]
	| ["error", Error]
	| ["invalid", string];

export interface Request {
	method: string;
	path: string;
	params: URLSearchParams;
}

export interface AccountHarness {
	clock: ManualClock;
	sockets: FakeWebSockets;
	/** The `oneway` recording the REST requests replay; mutable per test. */
	scenario: Scenario;
	calls: Call[];
	/** `METHOD /path?params` per REST request, auth params dropped. */
	requests: string[];
	/** Answers a request before the defaults; `undefined` falls through. */
	route: ((req: Request) => Response | undefined) | null;
	/** Holds every request to `path` until the returned release is called. */
	hold(path: string): () => void;
	/** Returns the calls so far and clears the log. */
	take(): Call[];
	statuses(): AccountStatus[];
	spot(): FakeSocket;
	futures(): FakeSocket;
	/** Opens the newest socket of each stream that is not open yet. */
	openStreams(): Promise<void>;
	/** Answers the newest spot subscription request. */
	answerSubscribe(status?: number): Promise<void>;
	/** Opens both streams, accepts the subscription and waits for `live`. */
	goLive(): Promise<void>;
	pushSpot(event: unknown): void;
	pushFutures(event: unknown): void;
	/** The adapter's own `fetchSnapshot()` against the same replay. */
	fetchSnapshot(): Promise<AccountSnapshot>;
	unsubscribe(): void;
}

function checked<T>(
	calls: Call[],
	schema: { safeParse(v: unknown): { success: boolean; error?: unknown } },
	kind: string,
	value: T,
	push: (v: T) => Call,
): void {
	const result = schema.safeParse(value);
	calls.push(
		result.success
			? push(value)
			: ["invalid", `${kind}: ${String(result.error)}`],
	);
}

/**
 * A subscribed Binance adapter on a manual clock, fake sockets and the
 * `oneway` recording. Listen keys are `lk-<n>`; position and symbol-config
 * reads with `symbol` answer the recorded rows of that symbol.
 */
export async function startAccount(): Promise<AccountHarness> {
	const clock = manualClock();
	const sockets = fakeWebSockets();
	const scenario = structuredClone(await loadScenario("oneway"));
	const replayed = replay(scenario);
	const calls: Call[] = [];
	const requests: string[] = [];
	const holds = new Map<string, Promise<void>>();
	let keys = 0;

	const fetch: Fetch = async (url, init) => {
		const u = new URL(url);
		const method = init.method ?? "GET";
		const params = new URLSearchParams(
			[...u.searchParams].filter(([k]) => !AUTH_PARAMS.has(k)),
		);
		const query = params.toString();
		requests.push(`${method} ${u.pathname}${query === "" ? "" : `?${query}`}`);
		await holds.get(u.pathname);
		const routed = h.route?.({ method, path: u.pathname, params });
		if (routed !== undefined) return routed;
		if (u.pathname === "/fapi/v1/listenKey") {
			return method === "POST"
				? Response.json({ listenKey: `lk-${++keys}` })
				: Response.json({});
		}
		const symbol = params.get("symbol");
		const bySymbol =
			u.pathname === "/fapi/v3/positionRisk"
				? scenario.positionRisk
				: u.pathname === "/fapi/v1/symbolConfig"
					? scenario.symbolConfig
					: undefined;
		if (symbol !== null && bySymbol !== undefined) {
			const rows = bySymbol.body as Array<{ symbol: string }>;
			return Response.json(rows.filter((r) => r.symbol === symbol));
		}
		return replayed.fetch(url, init);
	};

	const adapter = createBinanceAdapter({
		accountId: "acc-1",
		environment: "demo",
		credential: { kind: "hmac", apiKey: "k", secret: "s" },
		fetch,
		WebSocket: sockets.WebSocket,
		now: clock.now,
		timers: clock.timers,
	});

	const h: AccountHarness = {
		clock,
		sockets,
		scenario,
		calls,
		requests,
		route: null,
		hold(path) {
			const { promise, resolve } = Promise.withResolvers<void>();
			holds.set(path, promise);
			return () => {
				holds.delete(path);
				resolve();
			};
		},
		take() {
			return calls.splice(0);
		},
		statuses() {
			return calls.flatMap((c) => (c[0] === "status" ? [c[1]] : []));
		},
		spot: () => sockets.latest(SPOT_URL),
		futures: () => sockets.latest(FUTURES_URL),
		async openStreams() {
			await until(
				() => sockets.count(SPOT_URL) > 0 && sockets.count(FUTURES_URL) > 0,
			);
			for (const ws of [h.spot(), h.futures()]) {
				if (ws.readyState === 0) ws.open();
			}
		},
		async answerSubscribe(status = 200) {
			const ws = h.spot();
			await until(() => ws.sent.length > 0);
			const { id } = ws.frames().at(-1) as { id: string };
			ws.message(
				status === 200
					? { id, status, result: {} }
					: { id, status, error: { code: -1022, msg: "Signature invalid." } },
			);
		},
		async goLive() {
			await h.openStreams();
			await h.answerSubscribe();
			await until(() => h.statuses().at(-1) === "live");
		},
		pushSpot(event) {
			h.spot().message({ subscriptionId: 0, event });
		},
		pushFutures(event) {
			h.futures().message(event);
		},
		fetchSnapshot: () => adapter.fetchSnapshot(),
		unsubscribe: () => unsubscribe(),
	};

	const unsubscribe = adapter.subscribe({
		onSnapshot: (s) =>
			checked(calls, AccountSnapshotSchema, "snapshot", s, (v) => [
				"snapshot",
				v,
			]),
		onBalance: (b) =>
			checked(calls, BalanceSchema, "balance", b, (v) => ["balance", v]),
		onPosition: (p) =>
			checked(calls, PositionSchema, "position", p, (v) => ["position", v]),
		onOrder: (o) =>
			checked(calls, OrderSchema, "order", o, (v) => ["order", v]),
		onFill: (f) => checked(calls, FillSchema, "fill", f, (v) => ["fill", v]),
		onStatus: (s) => calls.push(["status", s]),
		onError: (err) => calls.push(["error", err]),
	});
	return h;
}
