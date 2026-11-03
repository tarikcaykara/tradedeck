import { describe, expect, test } from "bun:test";
import type { AccountHandlers } from "@tradedeck/adapter";
import type {
	Credential,
	InstrumentId,
	InstrumentKind,
	PriceUpdate,
} from "@tradedeck/core";
import type { AccountRow } from "@tradedeck/db";
import { type SessionAdapter, startSessions } from "../src/sessions.ts";
import { createStore, type Store } from "../src/store.ts";
import {
	BTC_PERP,
	BTC_SPOT,
	DEMO,
	ETH_BTC,
	ETH_SPOT,
	INSTRUMENTS,
	LIVE,
	order,
	position,
	snapshot,
	T0,
} from "./fixtures.ts";

const HMAC: Credential = { kind: "hmac", apiKey: "k", secret: "s" };

interface FakeOptions {
	instrumentsFail?: boolean;
	/** An instrument `subscribePrices` refuses, as Binance does an unsupported one. */
	refuse?: InstrumentId;
}

interface FakeAdapter {
	adapter: SessionAdapter;
	/** The live price subscriptions. */
	prices: Map<InstrumentId, (p: PriceUpdate) => void>;
	calls: { loadInstruments: number; unsubscribed: number };
	/** The handlers of the open account stream. */
	handlers(): AccountHandlers;
}

/** An adapter whose streams the test drives. */
function fakeAdapter(opts: FakeOptions = {}): FakeAdapter {
	let handlers: AccountHandlers | null = null;
	const prices = new Map<InstrumentId, (p: PriceUpdate) => void>();
	const calls = { loadInstruments: 0, unsubscribed: 0 };
	const adapter: SessionAdapter = {
		async loadInstruments(_kinds: InstrumentKind[]) {
			calls.loadInstruments++;
			if (opts.instrumentsFail) throw new Error("exchangeInfo down");
			return INSTRUMENTS;
		},
		subscribe(h) {
			handlers = h;
			return () => {
				handlers = null;
				calls.unsubscribed++;
			};
		},
		subscribePrices(ids, onPrice) {
			for (const id of ids) {
				if (id === opts.refuse)
					throw new Error(`binance: no price stream for ${id}`);
			}
			for (const id of ids) prices.set(id, onPrice);
			return () => {
				for (const id of ids) prices.delete(id);
			};
		},
	};
	return {
		adapter,
		prices,
		calls,
		handlers(): AccountHandlers {
			if (handlers === null) throw new Error("not subscribed");
			return handlers;
		},
	};
}

function setup(
	opts: {
		accounts?: AccountRow[];
		credentials?: Record<string, Credential | Error>;
		adapter?: FakeOptions;
	} = {},
) {
	const accounts = opts.accounts ?? [DEMO];
	const store = createStore();
	store.setAccounts(accounts);
	const fakes = new Map<string, FakeAdapter>();
	const logs: string[] = [];
	const credentials = opts.credentials ?? { [DEMO.id]: HMAC, [LIVE.id]: HMAC };
	const sessions = startSessions({
		accounts,
		secrets: {
			async get(id) {
				const c = credentials[id];
				if (c instanceof Error) throw c;
				return c ?? null;
			},
		},
		adapterFor: (account) => {
			const fake = fakeAdapter(opts.adapter);
			fakes.set(account.id, fake);
			return fake.adapter;
		},
		store,
		log: (line) => logs.push(line),
	});
	return {
		store,
		logs,
		sessions,
		fake(id: string) {
			const f = fakes.get(id);
			if (f === undefined) throw new Error(`no adapter for ${id}`);
			return f;
		},
		fakes,
	};
}

const status = (store: Store, id: string) =>
	store.state().accounts.find((a) => a.id === id)?.status;

describe("startSessions", () => {
	test("a missing keychain entry leaves the account down; no adapter is built", async () => {
		const t = setup({ credentials: {} });
		await t.sessions.started;
		expect(status(t.store, DEMO.id)).toBe("down");
		expect(t.fakes.size).toBe(0);
		expect(t.logs).toContain(
			"[binance-demo] no keychain entry; run bun run cli -- keys remove binance-demo, then keys add",
		);
	});

	test("an unreadable keychain entry leaves the account down and logs why", async () => {
		const t = setup({
			credentials: { [DEMO.id]: new Error("keychain locked") },
		});
		await t.sessions.started;
		expect(status(t.store, DEMO.id)).toBe("down");
		expect(t.logs).toContain("[binance-demo] keychain: keychain locked");
	});

	test.each<[string, Record<string, Credential | Error>]>([
		["a credential", { [DEMO.id]: HMAC }],
		["no entry", {}],
		["a keychain error", { [DEMO.id]: new Error("keychain locked") }],
	])(
		"stop() during the keychain lookup ends start-up there (%s)",
		async (_, credentials) => {
			const t = setup({ credentials });
			t.sessions.stop();
			await t.sessions.started;
			expect(t.fakes.size).toBe(0);
			expect(status(t.store, DEMO.id)).toBe("connecting");
			expect(t.logs).toEqual([]);
		},
	);

	test("instruments, statuses and the snapshot reach the store; the held set gets prices", async () => {
		const t = setup();
		await t.sessions.started;
		const f = t.fake(DEMO.id);
		f.handlers().onStatus("live");
		f.handlers().onSnapshot(snapshot());
		expect(status(t.store, DEMO.id)).toBe("live");
		expect([...f.prices.keys()].sort()).toEqual(
			[BTC_SPOT.id, BTC_PERP.id, ETH_BTC.id].sort(),
		);
		f.prices.get(BTC_PERP.id)?.({
			instrumentId: BTC_PERP.id,
			price: "80500",
			kind: "mark",
			ts: T0 + 1,
		});
		expect(t.store.prices()).toEqual([
			{ instrumentId: BTC_PERP.id, price: "80500", kind: "mark", ts: T0 + 1 },
		]);
	});

	test("the held set follows the account: a closed position and a new order", async () => {
		const t = setup();
		await t.sessions.started;
		const f = t.fake(DEMO.id);
		f.handlers().onSnapshot(snapshot());
		f.handlers().onPosition(position("0", T0 + 1));
		f.handlers().onOrder({
			...order("new", T0 + 1, ETH_SPOT.id),
			venueOrderId: "9002",
		});
		expect([...f.prices.keys()].sort()).toEqual(
			[BTC_SPOT.id, ETH_BTC.id, ETH_SPOT.id].sort(),
		);
	});

	test("instruments load once per environment", async () => {
		const second = { ...DEMO, id: "acc-demo-2", label: "binance-demo-2" };
		const t = setup({
			accounts: [DEMO, second, LIVE],
			credentials: { [DEMO.id]: HMAC, [second.id]: HMAC, [LIVE.id]: HMAC },
		});
		await t.sessions.started;
		const loads = [...t.fakes.values()].reduce(
			(n, f) => n + f.calls.loadInstruments,
			0,
		);
		expect(loads).toBe(2);
	});

	test("failed instruments are logged and the account still streams", async () => {
		const t = setup({ adapter: { instrumentsFail: true } });
		await t.sessions.started;
		const f = t.fake(DEMO.id);
		f.handlers().onSnapshot(snapshot());
		expect(t.logs).toContain("[binance-demo] instruments: exchangeInfo down");
		// Without instruments only positions and orders are known to be streamable.
		expect([...f.prices.keys()].sort()).toEqual(
			[BTC_PERP.id, ETH_BTC.id].sort(),
		);
	});

	test("a refused price subscription is logged; the rest are kept", async () => {
		const t = setup({ adapter: { refuse: ETH_BTC.id } });
		await t.sessions.started;
		const f = t.fake(DEMO.id);
		f.handlers().onSnapshot(snapshot());
		expect([...f.prices.keys()].sort()).toEqual(
			[BTC_SPOT.id, BTC_PERP.id].sort(),
		);
		expect(t.logs).toContain(
			`[binance-demo] prices: binance: no price stream for ${ETH_BTC.id}`,
		);
	});

	test("adapter errors are logged with the account label", async () => {
		const t = setup();
		await t.sessions.started;
		t.fake(DEMO.id).handlers().onError(new Error("GET /api/v3/account → 503"));
		expect(t.logs).toContain("[binance-demo] GET /api/v3/account → 503");
	});

	test("stop() ends the account stream and every price subscription", async () => {
		const t = setup();
		await t.sessions.started;
		const f = t.fake(DEMO.id);
		f.handlers().onSnapshot(snapshot());
		t.sessions.stop();
		expect(f.calls.unsubscribed).toBe(1);
		expect(f.prices.size).toBe(0);
	});
});
