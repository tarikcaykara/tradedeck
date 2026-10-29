import type {
	AccountSnapshot,
	AccountStatus,
	Balance,
	CredentialReport,
	Fill,
	Instrument,
	InstrumentId,
	InstrumentKind,
	Order,
	Position,
	PriceUpdate,
	Venue,
} from "@tradedeck/core";

/** What one instrument kind of a venue supports natively (architecture §5). */
export interface KindCapabilities {
	amend: "native" | "limit_only" | "qty_down_or_cancel_replace" | "none";
	cancelAll: "native" | "per_symbol" | "emulated";
	closePosition: "native" | "emulated";
	hedgeMode: boolean;
	batchMax: number;
	conditionalOrders: "inline" | "separate_api" | "none";
}

/** Callbacks of the private account stream (architecture §6). */
export interface AccountHandlers {
	/** Full account state after the streams connect and after every resync; replaces, never merges (§6). */
	onSnapshot(s: AccountSnapshot): void;
	onBalance(b: Balance): void;
	onPosition(p: Position): void;
	onOrder(o: Order): void;
	onFill(f: Fill): void;
	onStatus(s: AccountStatus): void;
	/** A failure the subscription recovers from or keeps retrying: snapshot, decode, keepalive, re-read, subscribe. For logs; never carries credentials. */
	onError(err: Error): void;
}

/**
 * One venue account. M1 members only (architecture §5); the M2 trade members
 * are added with M2, not stubbed here.
 */
export interface ExchangeAdapter {
	readonly venue: Venue;
	readonly capabilities: Partial<Record<InstrumentKind, KindCapabilities>>;
	verifyCredential(): Promise<CredentialReport>;
	loadInstruments(kinds: InstrumentKind[]): Promise<Instrument[]>;
	fetchSnapshot(): Promise<AccountSnapshot>;
	/** Returns unsubscribe. */
	subscribe(handlers: AccountHandlers): () => void;
	/** Returns unsubscribe. */
	subscribePrices(
		instrumentIds: InstrumentId[],
		onPrice: (p: PriceUpdate) => void,
	): () => void;
	fetchFills(instrumentId: InstrumentId, sinceTs: number): Promise<Fill[]>;
}
