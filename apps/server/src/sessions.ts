/**
 * One adapter session per account (docs/architecture.md §6): the credential
 * from the keychain, instruments once per environment, `subscribe()` into the
 * store, and price subscriptions that follow the account's held set.
 */
import type { ExchangeAdapter } from "@tradedeck/adapter";
import type {
	Credential,
	Environment,
	Instrument,
	InstrumentId,
} from "@tradedeck/core";
import type { AccountRow } from "@tradedeck/db";
import type { SecretStore } from "@tradedeck/secrets";
import type { Store } from "./store.ts";

/** The adapter members a session uses. */
export type SessionAdapter = Pick<
	ExchangeAdapter,
	"loadInstruments" | "subscribe" | "subscribePrices"
>;

export interface Sessions {
	/** Settles once every account has subscribed or failed to start. */
	started: Promise<void>;
	/** Ends every account stream and price subscription. */
	stop(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function startSessions(deps: {
	accounts: readonly AccountRow[];
	secrets: Pick<SecretStore, "get">;
	/** The credential lives only in the adapter it is passed to (hard rule 1). */
	adapterFor(account: AccountRow, credential: Credential): SessionAdapter;
	store: Store;
	log: (line: string) => void;
}): Sessions {
	const { store, log } = deps;
	const stops: Array<() => void> = [];
	let stopped = false;
	/** One load per environment, shared by its accounts; null when it failed. */
	const instruments = new Map<Environment, Promise<Instrument[] | null>>();

	async function start(account: AccountRow): Promise<void> {
		const say = (line: string) => log(`[${account.label}] ${line}`);
		let credential: Credential | null;
		try {
			credential = await deps.secrets.get(account.id);
		} catch (e) {
			say(`keychain: ${message(e)}`);
			store.setStatus(account.id, "down");
			return;
		}
		if (credential === null) {
			say(
				`no keychain entry; run bun run cli -- keys remove ${account.label}, then keys add`,
			);
			store.setStatus(account.id, "down");
			return;
		}
		const adapter = deps.adapterFor(account, credential);

		let load = instruments.get(account.environment);
		if (load === undefined) {
			load = adapter.loadInstruments(["spot", "linear"]).catch((e: unknown) => {
				say(`instruments: ${message(e)}`);
				return null;
			});
			instruments.set(account.environment, load);
		}
		const list = await load;
		if (list !== null) store.setInstruments(list);
		if (stopped) return;

		const prices = new Map<InstrumentId, () => void>();
		/** Subscribes what the held set gained and drops what it lost. */
		const syncPrices = () => {
			if (stopped) return;
			const held = new Set(store.heldInstruments(account.id));
			for (const [id, unsubscribe] of prices) {
				if (held.has(id)) continue;
				unsubscribe();
				prices.delete(id);
			}
			for (const id of held) {
				if (prices.has(id)) continue;
				try {
					prices.set(
						id,
						adapter.subscribePrices([id], (p) => store.applyPrice(p)),
					);
				} catch (e) {
					say(`prices: ${message(e)}`);
				}
			}
		};

		const unsubscribe = adapter.subscribe({
			onSnapshot(s) {
				store.applySnapshot(s);
				syncPrices();
			},
			onBalance(b) {
				store.applyBalance(b);
				syncPrices();
			},
			onPosition(p) {
				store.applyPosition(p);
				syncPrices();
			},
			onOrder(o) {
				store.applyOrder(o);
				syncPrices();
			},
			onFill: (f) => store.applyFill(f),
			onStatus: (s) => store.setStatus(account.id, s),
			onError: (e) => say(e.message),
		});
		stops.push(() => {
			unsubscribe();
			for (const off of prices.values()) off();
			prices.clear();
		});
	}

	const started = Promise.all(deps.accounts.map(start)).then(() => undefined);
	return {
		started,
		stop() {
			stopped = true;
			for (const stop of stops.splice(0)) stop();
		},
	};
}
