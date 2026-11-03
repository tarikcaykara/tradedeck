import { describe, expect, test } from "bun:test";
import type { ServerMessage } from "@tradedeck/core";
import { createStore, type Store } from "../src/store.ts";
import {
	BTC_PERP,
	BTC_SPOT,
	balance,
	DEMO,
	ETH_BTC,
	ETH_PERP,
	INSTRUMENTS,
	LIVE,
	order,
	position,
	snapshot,
	T0,
} from "./fixtures.ts";

function setup() {
	const store = createStore();
	store.setAccounts([DEMO, LIVE]);
	store.setInstruments(INSTRUMENTS);
	const sent: ServerMessage[] = [];
	store.subscribe((m) => sent.push(m));
	return { store, sent };
}

/** The demo account's snapshot inside the current state. */
function demo(store: Store) {
	return store.state().snapshots.find((s) => s.accountId === DEMO.id);
}

describe("createStore", () => {
	test("accounts start connecting; a status is emitted only when it changes", () => {
		const t = setup();
		expect(t.store.state().accounts.map((a) => a.status)).toEqual([
			"connecting",
			"connecting",
		]);
		t.store.setStatus(DEMO.id, "live");
		t.store.setStatus(DEMO.id, "live");
		t.store.setStatus(DEMO.id, "resyncing");
		expect(t.sent).toEqual([
			{ type: "account_status", accountId: DEMO.id, status: "live" },
			{ type: "account_status", accountId: DEMO.id, status: "resyncing" },
		]);
	});

	test("a snapshot replaces the account's state and is emitted as the whole state", () => {
		const t = setup();
		t.store.applySnapshot(snapshot());
		t.store.applySnapshot(
			snapshot({
				balances: [balance("USDT", "7")],
				positions: [],
				openOrders: [],
			}),
		);
		expect(demo(t.store)).toEqual({
			accountId: DEMO.id,
			balances: [balance("USDT", "7")],
			positions: [],
			openOrders: [],
			fetchedAt: T0,
		});
		expect(t.sent.at(-1)).toEqual({ type: "snapshot", state: t.store.state() });
	});

	test("state() lists only the instruments the snapshots reference", () => {
		const t = setup();
		t.store.applySnapshot(snapshot());
		// BTC balance → BTCUSDT; the position → BTC perp; the order → ETHBTC.
		expect(
			t.store
				.state()
				.instruments.map((i) => i.id)
				.sort(),
		).toEqual([BTC_SPOT.id, BTC_PERP.id, ETH_BTC.id].sort());
	});

	test("heldInstruments: positions, open orders and <asset>USDT for spot balances other than USDT", () => {
		const t = setup();
		t.store.applySnapshot(
			snapshot({
				balances: [
					balance("USDT", "100"),
					balance("BTC", "1"),
					balance("DOGE", "5"),
				],
			}),
		);
		// DOGEUSDT is not a known instrument, so it is left out.
		expect(t.store.heldInstruments(DEMO.id).sort()).toEqual(
			[BTC_SPOT.id, BTC_PERP.id, ETH_BTC.id].sort(),
		);
		expect(t.store.heldInstruments(LIVE.id)).toEqual([]);
	});

	describe("deltas", () => {
		test("a position older than the stored one is dropped; a newer one replaces it", () => {
			const t = setup();
			t.store.applySnapshot(
				snapshot({ positions: [position("0.01", T0 + 10)] }),
			);
			t.sent.length = 0;
			t.store.applyPosition(position("0.02", T0 + 5));
			expect(t.sent).toEqual([]);
			t.store.applyPosition(position("0.03", T0 + 20));
			expect(demo(t.store)?.positions).toEqual([position("0.03", T0 + 20)]);
			expect(t.sent).toEqual([
				{ type: "position", position: position("0.03", T0 + 20) },
			]);
		});

		test("a position of size 0 is removed and still emitted", () => {
			const t = setup();
			t.store.applySnapshot(snapshot());
			t.store.applyPosition(position("0.000", T0 + 1));
			expect(demo(t.store)?.positions).toEqual([]);
			expect(t.sent.at(-1)).toEqual({
				type: "position",
				position: position("0.000", T0 + 1),
			});
		});

		test("an order is dropped when older, removed on a terminal status, otherwise replaced", () => {
			const t = setup();
			t.store.applySnapshot(snapshot({ openOrders: [order("new", T0 + 10)] }));
			t.store.applyOrder(order("filled", T0 + 5));
			expect(demo(t.store)?.openOrders).toEqual([order("new", T0 + 10)]);
			t.store.applyOrder(order("partially_filled", T0 + 11));
			expect(demo(t.store)?.openOrders).toEqual([
				order("partially_filled", T0 + 11),
			]);
			for (const status of [
				"filled",
				"canceled",
				"rejected",
				"expired",
			] as const) {
				t.store.applyOrder(order("new", T0 + 12));
				t.store.applyOrder(order(status, T0 + 13));
				expect(demo(t.store)?.openOrders).toEqual([]);
			}
		});

		test("a balance older than the stored one is dropped; a zero balance is removed", () => {
			const t = setup();
			t.store.applySnapshot(
				snapshot({ balances: [balance("BTC", "1", T0 + 10)] }),
			);
			t.sent.length = 0;
			t.store.applyBalance(balance("BTC", "2", T0 + 5));
			expect(t.sent).toEqual([]);
			t.store.applyBalance(balance("BTC", "0", T0 + 20));
			expect(demo(t.store)?.balances).toEqual([]);
			expect(t.sent).toEqual([
				{ type: "balance", balance: balance("BTC", "0", T0 + 20) },
			]);
		});

		test("a delta for an account without a snapshot is dropped", () => {
			const t = setup();
			t.store.applyPosition(position("1"));
			expect(t.sent).toEqual([]);
			expect(t.store.state().snapshots).toEqual([]);
		});

		test("a new position joins the held set", () => {
			const t = setup();
			t.store.applySnapshot(snapshot({ positions: [] }));
			t.store.applyPosition({ ...position("1"), instrumentId: ETH_PERP.id });
			expect(t.store.heldInstruments(DEMO.id)).toContain(ETH_PERP.id);
		});
	});

	describe("prices", () => {
		test("the latest price per instrument is kept and emitted; an older one is dropped", () => {
			const t = setup();
			const tick = (price: string, ts: number) =>
				({ instrumentId: BTC_PERP.id, price, kind: "mark", ts }) as const;
			t.store.applyPrice(tick("1", T0 + 2));
			t.store.applyPrice(tick("2", T0 + 1));
			t.store.applyPrice(tick("3", T0 + 3));
			expect(t.store.prices()).toEqual([tick("3", T0 + 3)]);
			expect(t.sent).toEqual([
				{ type: "price", ...tick("1", T0 + 2) },
				{ type: "price", ...tick("3", T0 + 3) },
			]);
		});
	});

	test("a fill is emitted, never stored", () => {
		const t = setup();
		const fill = {
			accountId: DEMO.id,
			instrumentId: BTC_PERP.id,
			venueTradeId: "1",
			venueOrderId: "9001",
			side: "buy",
			qty: "0.01",
			price: "80000",
			fee: "0.03",
			feeAsset: "USDT",
			realizedPnl: "0",
			ts: T0,
		} as const;
		t.store.applyFill(fill);
		expect(t.sent).toEqual([{ type: "fill", fill }]);
	});

	test("unsubscribe stops the messages", () => {
		const t = setup();
		const later: ServerMessage[] = [];
		const off = t.store.subscribe((m) => later.push(m));
		off();
		t.store.setStatus(DEMO.id, "live");
		expect(later).toEqual([]);
	});
});
