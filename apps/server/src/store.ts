/**
 * The server's in-memory state (docs/architecture.md §6): one snapshot per
 * account, replaced on every `onSnapshot` and changed by deltas in venue time
 * order. Every change it keeps is emitted as a protocol message; a change it
 * drops is not. Pure: no I/O, no clock.
 */
import type {
	AccountSnapshot,
	AccountStatus,
	AccountSummary,
	Balance,
	Fill,
	Instrument,
	InstrumentId,
	Order,
	OrderStatus,
	Position,
	PriceUpdate,
	ServerMessage,
	StateSnapshot,
} from "@tradedeck/core";

export type StoreAccount = Omit<AccountSummary, "status">;

export interface Store {
	/** Every account starts `connecting`. */
	setAccounts(accounts: readonly StoreAccount[]): void;
	setInstruments(instruments: readonly Instrument[]): void;
	/** Emitted only when it changes. */
	setStatus(accountId: string, status: AccountStatus): void;
	/** Replaces the account's state; emits the whole state. */
	applySnapshot(snapshot: AccountSnapshot): void;
	applyBalance(balance: Balance): void;
	applyPosition(position: Position): void;
	applyOrder(order: Order): void;
	/** Emitted only; the ledger (M1 issue 12) stores fills. */
	applyFill(fill: Fill): void;
	applyPrice(price: PriceUpdate): void;
	state(): StateSnapshot;
	/** The latest price of every instrument that has one. */
	prices(): PriceUpdate[];
	/**
	 * The instruments whose price the account needs: its positions, its open
	 * orders, and `<venue>:spot:<asset>USDT` for every spot balance other than
	 * USDT when that instrument is known.
	 */
	heldInstruments(accountId: string): InstrumentId[];
	subscribe(listener: (message: ServerMessage) => void): () => void;
}

/** Whether an order leaves the open-orders list on reaching the status. */
const TERMINAL: Record<OrderStatus, boolean> = {
	new: false,
	partially_filled: false,
	triggered: false,
	filled: true,
	canceled: true,
	rejected: true,
	expired: true,
};

interface AccountState {
	summary: AccountSummary;
	snapshot: {
		balances: Map<string, Balance>;
		positions: Map<string, Position>;
		orders: Map<string, Order>;
		fetchedAt: number;
	} | null;
}

const balanceKey = (b: Balance) => `${b.scope}|${b.asset}`;
const positionKey = (p: Position) => `${p.instrumentId}|${p.positionSide}`;
const orderKey = (o: Order) => `${o.instrumentId}|${o.venueOrderId}`;
/** A valid decimal string without a non-zero digit is zero ("0.000", "-0"). */
const isZero = (value: string) => !/[1-9]/.test(value);

export function createStore(): Store {
	const accounts = new Map<string, AccountState>();
	const instruments = new Map<InstrumentId, Instrument>();
	const prices = new Map<InstrumentId, PriceUpdate>();
	const listeners = new Set<(message: ServerMessage) => void>();

	function emit(message: ServerMessage): void {
		for (const listener of [...listeners]) listener(message);
	}

	function snapshotOf(accountId: string): AccountState["snapshot"] {
		return accounts.get(accountId)?.snapshot ?? null;
	}

	/** Puts or removes `next` unless the stored value is newer; true when applied. */
	function put<T extends { updatedAt: number }>(
		map: Map<string, T>,
		key: string,
		next: T,
		remove: boolean,
	): boolean {
		const current = map.get(key);
		if (current !== undefined && next.updatedAt < current.updatedAt)
			return false;
		if (remove) map.delete(key);
		else map.set(key, next);
		return true;
	}

	function held(accountId: string): InstrumentId[] {
		const a = accounts.get(accountId);
		if (a === undefined || a.snapshot === null) return [];
		const ids = new Set<InstrumentId>();
		for (const p of a.snapshot.positions.values()) ids.add(p.instrumentId);
		for (const o of a.snapshot.orders.values()) ids.add(o.instrumentId);
		for (const b of a.snapshot.balances.values()) {
			if (b.scope !== "spot" || b.asset === "USDT") continue;
			const pair: InstrumentId = `${a.summary.venue}:spot:${b.asset}USDT`;
			if (instruments.has(pair)) ids.add(pair);
		}
		return [...ids];
	}

	function state(): StateSnapshot {
		const referenced = new Set<InstrumentId>();
		const snapshots: AccountSnapshot[] = [];
		for (const [accountId, a] of accounts) {
			if (a.snapshot === null) continue;
			for (const id of held(accountId)) referenced.add(id);
			snapshots.push({
				accountId,
				balances: [...a.snapshot.balances.values()],
				positions: [...a.snapshot.positions.values()],
				openOrders: [...a.snapshot.orders.values()],
				fetchedAt: a.snapshot.fetchedAt,
			});
		}
		return {
			accounts: [...accounts.values()].map((a) => a.summary),
			instruments: [...referenced].flatMap((id) => instruments.get(id) ?? []),
			snapshots,
		};
	}

	return {
		setAccounts(list) {
			accounts.clear();
			for (const a of list) {
				accounts.set(a.id, {
					summary: {
						id: a.id,
						label: a.label,
						venue: a.venue,
						environment: a.environment,
						status: "connecting",
					},
					snapshot: null,
				});
			}
		},
		setInstruments(list) {
			for (const i of list) instruments.set(i.id, i);
		},
		setStatus(accountId, status) {
			const a = accounts.get(accountId);
			if (a === undefined || a.summary.status === status) return;
			a.summary = { ...a.summary, status };
			emit({ type: "account_status", accountId, status });
		},
		applySnapshot(snapshot) {
			const a = accounts.get(snapshot.accountId);
			if (a === undefined) return;
			a.snapshot = {
				balances: new Map(snapshot.balances.map((b) => [balanceKey(b), b])),
				positions: new Map(snapshot.positions.map((p) => [positionKey(p), p])),
				orders: new Map(snapshot.openOrders.map((o) => [orderKey(o), o])),
				fetchedAt: snapshot.fetchedAt,
			};
			emit({ type: "snapshot", state: state() });
		},
		applyBalance(balance) {
			const s = snapshotOf(balance.accountId);
			if (s === null) return;
			if (
				put(s.balances, balanceKey(balance), balance, isZero(balance.total))
			) {
				emit({ type: "balance", balance });
			}
		},
		applyPosition(position) {
			const s = snapshotOf(position.accountId);
			if (s === null) return;
			if (
				put(s.positions, positionKey(position), position, isZero(position.size))
			) {
				emit({ type: "position", position });
			}
		},
		applyOrder(order) {
			const s = snapshotOf(order.accountId);
			if (s === null) return;
			if (put(s.orders, orderKey(order), order, TERMINAL[order.status])) {
				emit({ type: "order", order });
			}
		},
		applyFill(fill) {
			emit({ type: "fill", fill });
		},
		applyPrice(price) {
			const current = prices.get(price.instrumentId);
			if (current !== undefined && price.ts < current.ts) return;
			prices.set(price.instrumentId, price);
			emit({ type: "price", ...price });
		},
		state,
		prices: () => [...prices.values()],
		heldInstruments: held,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
