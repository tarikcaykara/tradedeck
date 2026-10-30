import type {
	AccountHandlers,
	Timers,
	WebSocketCtor,
} from "@tradedeck/adapter";
import type {
	AccountSnapshot,
	AccountStatus,
	Environment,
	OrderStatus,
	Position,
} from "@tradedeck/core";
import type { z } from "zod";
import { ENDPOINTS } from "./endpoints.ts";
import {
	algoOrderOf,
	decodeFuturesEvent,
	decodeSpotEvent,
	futuresFillOf,
	futuresOrderOf,
	type StreamEvent,
	spotBalanceOf,
	spotFillOf,
	spotOrderOf,
} from "./events.ts";
import type { BinanceHttp } from "./http.ts";
import {
	FuturesBalances,
	fetchSnapshot,
	PositionRisk,
	SymbolConfigs,
	toFuturesBalance,
	toPositions,
} from "./snapshot.ts";
import {
	openFuturesUserStream,
	openSpotUserStream,
	type UserStreamListener,
} from "./user-streams.ts";

export interface SubscribeDeps {
	accountId: string;
	environment: Environment;
	http: BinanceHttp;
	now: () => number;
	timers: Timers;
	/** Default `globalThis.WebSocket`. */
	WebSocket?: WebSocketCtor;
}

/** Consecutive failures (a stream down while not live, or a failed snapshot) before `down`. */
const DOWN_AFTER_FAILURES = 3;
const MAX_RETRY_MS = 30_000;

/** Statuses that end an order's life (architecture §6). */
const TERMINAL: Readonly<Record<OrderStatus, boolean>> = {
	new: false,
	partially_filled: false,
	triggered: false,
	filled: true,
	canceled: true,
	rejected: true,
	expired: true,
};

type Stream = "spot" | "futures";

const asError = (err: unknown): Error =>
	err instanceof Error ? err : new Error(String(err));

/**
 * The account subscription (architecture §6). Opens the spot and futures
 * user-data streams, takes a snapshot once both are up and after every drop
 * or resync, buffers events until it lands, then applies them live.
 *
 * - Status: `connecting` at once; `live` after a snapshot with both streams
 *   up; `resyncing` when a live account loses a stream or must re-snapshot;
 *   `down` after `DOWN_AFTER_FAILURES` consecutive failures, until `live`.
 *   Emitted on change only.
 * - Futures positions and balances are re-read over REST when an event names
 *   them: the events lack mark price, liquidation price and leverage.
 *
 * Returns unsubscribe; nothing is emitted after it.
 */
export function subscribeAccount(
	deps: SubscribeDeps,
	target: AccountHandlers,
): () => void {
	const { accountId, http, timers } = deps;
	let status: AccountStatus | null = null;
	let closed = false;
	// Every emission checks `closed`: a handler may unsubscribe mid-dispatch,
	// e.g. between an order and its fill.
	const handlers: AccountHandlers = {
		onSnapshot(s) {
			if (!closed) target.onSnapshot(s);
		},
		onBalance(b) {
			if (!closed) target.onBalance(b);
		},
		onPosition(p) {
			if (!closed) target.onPosition(p);
		},
		onOrder(o) {
			if (!closed) target.onOrder(o);
		},
		onFill(f) {
			if (!closed) target.onFill(f);
		},
		onStatus(s) {
			if (!closed) target.onStatus(s);
		},
		onError(err) {
			if (!closed) target.onError(err);
		},
	};
	// Bumped by every drop, resync and unsubscribe: an async continuation
	// started under an older generation does nothing.
	let generation = 0;
	const up: Record<Stream, boolean> = { spot: false, futures: false };
	let syncing = false;
	let buffering = true;
	let buffer: StreamEvent[] = [];
	let failures = 0;
	let retryTimer: unknown = null;
	/** Futures positions by `instrumentId|positionSide`, to zero one a re-read no longer returns. */
	const positions = new Map<string, Position>();
	/** Futures order creation times by `instrumentId|venueOrderId|clientOrderId`. */
	const createdAt = new Map<string, number>();
	/** Position re-reads in flight per symbol; `again` repeats one once it lands. */
	const reads = new Map<string, { again: boolean; eventE: number }>();
	let balanceRead: { again: boolean; assets: Set<string> } | null = null;

	const positionKey = (p: Position) => `${p.instrumentId}|${p.positionSide}`;

	function setStatus(s: AccountStatus): void {
		if (closed || status === s) return;
		status = s;
		handlers.onStatus(s);
	}

	function fail(): void {
		failures++;
		if (failures >= DOWN_AFTER_FAILURES) setStatus("down");
	}

	/** Drops everything derived from the stream since the last snapshot and takes a new one. */
	function resync(): void {
		generation++;
		buffering = true;
		buffer = [];
		reads.clear();
		balanceRead = null;
		syncing = false;
		if (status === "live") setStatus("resyncing");
		maybeSync();
	}

	function maybeSync(): void {
		if (
			closed ||
			syncing ||
			retryTimer !== null ||
			!up.spot ||
			!up.futures ||
			status === "live"
		) {
			return;
		}
		syncing = true;
		const g = generation;
		fetchSnapshot(http, accountId, deps.now).then(
			(snapshot) => {
				if (closed || g !== generation) return;
				syncing = false;
				synced(snapshot, g);
			},
			(err: unknown) => {
				if (closed || g !== generation) return;
				syncing = false;
				handlers.onError(asError(err));
				fail();
				const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** (failures - 1));
				retryTimer = timers.setTimeout(() => {
					retryTimer = null;
					maybeSync();
				}, delay);
			},
		);
	}

	function synced(snapshot: AccountSnapshot, g: number): void {
		handlers.onSnapshot(snapshot);
		positions.clear();
		for (const p of snapshot.positions) positions.set(positionKey(p), p);
		createdAt.clear();
		for (const o of snapshot.openOrders) {
			createdAt.set(
				`${o.instrumentId}|${o.venueOrderId}|${o.clientOrderId}`,
				o.createdAt,
			);
		}
		buffering = false;
		// Stable: same-type events keep their arrival order on equal `E`.
		const events = buffer.sort((a, b) => a.E - b.E);
		buffer = [];
		for (const event of events) {
			apply(event);
			if (closed || g !== generation) return;
		}
		failures = 0;
		setStatus("live");
	}

	function apply(event: StreamEvent): void {
		switch (event.kind) {
			case "spotOrder": {
				handlers.onOrder(spotOrderOf(accountId, event.report));
				const fill = spotFillOf(accountId, event.report);
				if (fill !== null) handlers.onFill(fill);
				return;
			}
			case "spotBalances":
				for (const row of event.rows) {
					handlers.onBalance(spotBalanceOf(accountId, row));
				}
				return;
			case "futuresOrder": {
				const o = event.order;
				const key = `binance:linear:${o.s}|${o.i}|${o.c}`;
				if (o.x === "NEW") createdAt.set(key, o.T);
				const order = futuresOrderOf(
					accountId,
					o,
					createdAt.get(key) ?? event.E,
				);
				if (TERMINAL[order.status]) createdAt.delete(key);
				handlers.onOrder(order);
				const fill = futuresFillOf(accountId, o);
				if (fill !== null) handlers.onFill(fill);
				return;
			}
			case "algoOrder": {
				const { algo, T } = event;
				const key = `binance:linear:${algo.s}|${algo.aid}|${algo.caid}`;
				if (algo.X === "new") createdAt.set(key, T);
				const order = algoOrderOf(
					accountId,
					algo,
					T,
					createdAt.get(key) ?? event.E,
				);
				if (TERMINAL[order.status]) createdAt.delete(key);
				handlers.onOrder(order);
				return;
			}
			case "accountUpdate":
				for (const symbol of event.symbols) readPosition(symbol, event.E);
				if (event.assets.length > 0) readBalances(event.assets);
				return;
			case "leverage": {
				const prefix = `binance:linear:${event.symbol}|`;
				if ([...positions.keys()].some((k) => k.startsWith(prefix))) {
					readPosition(event.symbol, event.E);
				}
				return;
			}
		}
	}

	function readPosition(symbol: string, eventE: number): void {
		const inFlight = reads.get(symbol);
		if (inFlight !== undefined) {
			inFlight.again = true;
			inFlight.eventE = Math.max(inFlight.eventE, eventE);
			return;
		}
		const state = { again: false, eventE };
		reads.set(symbol, state);
		void rereadPositions(symbol, state, generation);
	}

	async function rereadPositions(
		symbol: string,
		state: { again: boolean; eventE: number },
		g: number,
	): Promise<void> {
		for (;;) {
			const { eventE } = state;
			let fresh: Position[];
			try {
				const [risk, configs] = await Promise.all([
					http.request(ENDPOINTS.positionRisk, PositionRisk, { symbol }),
					http.request(ENDPOINTS.symbolConfig, SymbolConfigs, { symbol }),
				]);
				fresh = toPositions(accountId, risk, configs);
			} catch (err) {
				if (closed || g !== generation) return;
				handlers.onError(asError(err));
				resync();
				return;
			}
			if (closed || g !== generation) return;
			const seen = new Set<string>();
			for (const p of fresh) {
				const key = positionKey(p);
				seen.add(key);
				positions.set(key, p);
				handlers.onPosition(p);
			}
			// A cached position the venue no longer returns was closed.
			const prefix = `binance:linear:${symbol}|`;
			for (const [key, cached] of positions) {
				if (!key.startsWith(prefix) || seen.has(key)) continue;
				positions.delete(key);
				handlers.onPosition({
					...cached,
					size: "0",
					unrealizedPnl: "0",
					updatedAt: Math.max(cached.updatedAt, eventE),
				});
			}
			if (!state.again) {
				reads.delete(symbol);
				return;
			}
			state.again = false;
		}
	}

	function readBalances(assets: string[]): void {
		if (balanceRead !== null) {
			balanceRead.again = true;
			for (const a of assets) balanceRead.assets.add(a);
			return;
		}
		const state = { again: false, assets: new Set(assets) };
		balanceRead = state;
		void rereadBalances(state, generation);
	}

	async function rereadBalances(
		state: { again: boolean; assets: Set<string> },
		g: number,
	): Promise<void> {
		for (;;) {
			const assets = [...state.assets];
			state.assets.clear();
			let rows: z.infer<typeof FuturesBalances>;
			try {
				rows = await http.request(ENDPOINTS.futuresBalance, FuturesBalances);
			} catch (err) {
				if (closed || g !== generation) return;
				handlers.onError(asError(err));
				resync();
				return;
			}
			if (closed || g !== generation) return;
			for (const asset of assets) {
				const row = rows.find((r) => r.asset === asset);
				handlers.onBalance(
					(row === undefined ? null : toFuturesBalance(accountId, row)) ?? {
						accountId,
						scope: "derivs",
						asset,
						free: "0",
						locked: "0",
						total: "0",
					},
				);
			}
			if (!state.again) {
				balanceRead = null;
				return;
			}
			state.again = false;
		}
	}

	function listener(
		stream: Stream,
		decodeEvent: (raw: unknown) => StreamEvent | null,
	): UserStreamListener {
		return {
			onEvent(raw) {
				if (closed) return;
				let event: StreamEvent | null;
				try {
					event = decodeEvent(raw);
				} catch (err) {
					handlers.onError(asError(err));
					resync();
					return;
				}
				if (event === null) return;
				if (buffering) buffer.push(event);
				else apply(event);
			},
			onUp() {
				if (closed) return;
				up[stream] = true;
				maybeSync();
			},
			onDown() {
				if (closed) return;
				up[stream] = false;
				// From live a drop is the expected path; otherwise it is a failure.
				const wasLive = status === "live";
				resync();
				if (!wasLive) fail();
			},
			onError(err) {
				handlers.onError(err);
			},
		};
	}

	setStatus("connecting");
	const streamDeps = {
		environment: deps.environment,
		http,
		now: deps.now,
		timers,
		...(deps.WebSocket === undefined ? {} : { WebSocket: deps.WebSocket }),
	};
	const spot = openSpotUserStream(
		streamDeps,
		listener("spot", decodeSpotEvent),
	);
	const futures = openFuturesUserStream(
		streamDeps,
		listener("futures", decodeFuturesEvent),
	);

	return () => {
		if (closed) return;
		closed = true;
		generation++;
		spot.close();
		futures.close();
		if (retryTimer !== null) {
			timers.clearTimeout(retryTimer);
			retryTimer = null;
		}
	};
}
