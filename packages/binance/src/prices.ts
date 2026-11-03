/**
 * `subscribePrices` (docs/architecture.md §6): spot last price from
 * `<symbol>@miniTicker` (1 s) and futures mark price from
 * `<symbol>@markPrice@1s`, on one raw market-stream socket per market,
 * shared by every subscription of the adapter.
 */
import {
	createReconnectingSocket,
	type ReconnectingSocket,
	type SocketStatus,
	type Timers,
	type WebSocketCtor,
} from "@tradedeck/adapter";
import type { Environment, InstrumentId, PriceUpdate } from "@tradedeck/core";
import { z } from "zod";
import { venueDecimal } from "./decimal.ts";
import { BINANCE_STREAM_URLS } from "./env.ts";

export interface PriceFeedDeps {
	environment: Environment;
	now: () => number;
	timers: Timers;
	/** Default `globalThis.WebSocket`. */
	WebSocket?: WebSocketCtor;
}

export interface PriceFeed {
	/**
	 * Delivers every price of `instrumentIds` to `onPrice` until the returned
	 * function is called. Throws, opening nothing, for an instrument Binance
	 * streams no price for here (only `spot` and `linear`).
	 */
	subscribe(
		instrumentIds: readonly InstrumentId[],
		onPrice: (p: PriceUpdate) => void,
	): () => void;
}

type Market = "spot" | "futures";

/**
 * At most one `SUBSCRIBE` and one `UNSUBSCRIBE` per interval: spot allows 5
 * incoming messages per second per connection, pings and pongs included,
 * and drops a connection that sends more.
 */
const CONTROL_INTERVAL_MS = 1000;
/** Spot's documented per-connection maximum; applied to futures as well. */
const MAX_STREAMS = 1024;

const Event = z.looseObject({ e: z.string() });
const MiniTicker = z.looseObject({
	E: z.number().int().nonnegative(),
	s: z.string().min(1),
	c: venueDecimal,
});
const MarkPrice = z.looseObject({
	E: z.number().int().nonnegative(),
	s: z.string().min(1),
	p: venueDecimal,
});

interface Route {
	market: Market;
	stream: string;
}

function route(id: InstrumentId): Route {
	const [venue, kind, ...rest] = id.split(":");
	const symbol = rest.join(":").toLowerCase();
	if (venue === "binance" && kind === "spot") {
		return { market: "spot", stream: `${symbol}@miniTicker` };
	}
	if (venue === "binance" && kind === "linear") {
		return { market: "futures", stream: `${symbol}@markPrice@1s` };
	}
	throw new Error(`binance: no price stream for ${id}`);
}

interface Subscription {
	onPrice: (p: PriceUpdate) => void;
}

/** One market's socket, open while any of its instruments is subscribed. */
interface Connection {
	socket: ReconnectingSocket;
	/** The streams subscribed on the current connection; empty while not open. */
	sent: Set<string>;
	open: boolean;
	flushTimer: unknown;
	lastSentAt: number | null;
	requests: number;
}

export function createPriceFeed(deps: PriceFeedDeps): PriceFeed {
	const { timers, now } = deps;
	const subscribers = new Map<InstrumentId, Set<Subscription>>();
	const connections: Record<Market, Connection | null> = {
		spot: null,
		futures: null,
	};

	function wanted(market: Market): Set<string> {
		const streams = new Set<string>();
		for (const id of subscribers.keys()) {
			const r = route(id);
			if (r.market === market) streams.add(r.stream);
		}
		return streams;
	}

	function send(c: Connection, method: string, params: string[]): void {
		c.socket.send(JSON.stringify({ method, params, id: ++c.requests }));
	}

	function flush(market: Market): void {
		const c = connections[market];
		if (c === null) return;
		c.flushTimer = null;
		if (!c.open) return;
		const target = wanted(market);
		const add = [...target].filter((s) => !c.sent.has(s));
		const remove = [...c.sent].filter((s) => !target.has(s));
		if (add.length > 0) send(c, "SUBSCRIBE", add);
		if (remove.length > 0) send(c, "UNSUBSCRIBE", remove);
		if (add.length > 0 || remove.length > 0) c.lastSentAt = now();
		c.sent = target;
	}

	function scheduleFlush(market: Market): void {
		const c = connections[market];
		if (c === null || !c.open || c.flushTimer !== null) return;
		const wait =
			c.lastSentAt === null
				? 0
				: Math.max(0, c.lastSentAt + CONTROL_INTERVAL_MS - now());
		c.flushTimer = timers.setTimeout(() => flush(market), wait);
	}

	function emit(id: InstrumentId, p: PriceUpdate): void {
		for (const s of subscribers.get(id) ?? []) s.onPrice(p);
	}

	function onMessage(c: Connection, market: Market, data: string): void {
		let json: unknown;
		try {
			json = JSON.parse(data);
		} catch {
			c.socket.reconnect();
			return;
		}
		// Answers to SUBSCRIBE / UNSUBSCRIBE (`{ result, id }`) carry no `e`.
		const event = Event.safeParse(json).data;
		if (event === undefined) return;
		if (event.e === "serverShutdown") {
			c.socket.reconnect();
			return;
		}
		if (market === "spot" && event.e === "24hrMiniTicker") {
			const t = MiniTicker.safeParse(json).data;
			if (t === undefined) return;
			const instrumentId: InstrumentId = `binance:spot:${t.s}`;
			emit(instrumentId, { instrumentId, price: t.c, kind: "last", ts: t.E });
		} else if (market === "futures" && event.e === "markPriceUpdate") {
			const m = MarkPrice.safeParse(json).data;
			if (m === undefined) return;
			const instrumentId: InstrumentId = `binance:linear:${m.s}`;
			emit(instrumentId, { instrumentId, price: m.p, kind: "mark", ts: m.E });
		}
	}

	function onStatus(c: Connection, market: Market, s: SocketStatus): void {
		if (s.state === "open") {
			c.open = true;
			c.sent = new Set();
			if (c.flushTimer !== null) {
				timers.clearTimeout(c.flushTimer);
				c.flushTimer = null;
			}
			flush(market);
		} else if (s.state === "closed") {
			c.open = false;
			c.sent = new Set();
		}
	}

	function connect(market: Market): void {
		if (connections[market] !== null) return;
		const url = BINANCE_STREAM_URLS[deps.environment][`${market}Market`];
		// Set right after the socket exists. Its first status ("connecting")
		// arrives synchronously and is ignored; the rest arrive later. A frame
		// from a socket that was closed is ignored too, so it never acts on a
		// newer connection of the same market.
		let c: Connection | null = null;
		const current = (): Connection | null =>
			c !== null && connections[market] === c ? c : null;
		const socket = createReconnectingSocket({
			url: () => url,
			onMessage: (data) => {
				const live = current();
				if (live !== null) onMessage(live, market, data);
			},
			onStatus: (s) => {
				const live = current();
				if (live !== null) onStatus(live, market, s);
			},
			now,
			timers,
			...(deps.WebSocket === undefined ? {} : { WebSocket: deps.WebSocket }),
		});
		c = {
			socket,
			sent: new Set(),
			open: false,
			flushTimer: null,
			lastSentAt: null,
			requests: 0,
		};
		connections[market] = c;
	}

	function disconnectIfIdle(market: Market): void {
		const c = connections[market];
		if (c === null || wanted(market).size > 0) return;
		if (c.flushTimer !== null) timers.clearTimeout(c.flushTimer);
		connections[market] = null;
		c.socket.close();
	}

	return {
		subscribe(instrumentIds, onPrice) {
			const ids = [...new Set(instrumentIds)];
			const markets = new Set(ids.map((id) => route(id).market));
			// Checked before anything is registered, so a refused call leaves
			// every existing subscription as it was.
			for (const market of markets) {
				const streams = wanted(market);
				for (const id of ids) {
					const r = route(id);
					if (r.market === market) streams.add(r.stream);
				}
				if (streams.size > MAX_STREAMS) {
					throw new Error(
						`binance: more than ${MAX_STREAMS} ${market} price streams on one connection`,
					);
				}
			}
			const subscription: Subscription = { onPrice };
			for (const id of ids) {
				const set = subscribers.get(id) ?? new Set();
				set.add(subscription);
				subscribers.set(id, set);
			}
			for (const market of markets) {
				connect(market);
				scheduleFlush(market);
			}
			let done = false;
			return () => {
				if (done) return;
				done = true;
				for (const id of ids) {
					const set = subscribers.get(id);
					set?.delete(subscription);
					if (set?.size === 0) subscribers.delete(id);
				}
				for (const market of markets) {
					disconnectIfIdle(market);
					scheduleFlush(market);
				}
			};
		},
	};
}
