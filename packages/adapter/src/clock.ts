/**
 * Venue time for signed requests: local time plus the offset measured against
 * the venue's server-time endpoint.
 */
export interface ServerClock {
	/** Syncs first when never synced, stale or invalidated. */
	timestamp(): Promise<number>;
	/** Forces a sync before the next timestamp, e.g. after a venue timestamp rejection. */
	invalidate(): void;
}

export function createServerClock(opts: {
	now: () => number;
	/** Called lazily, so it may use a client that is built with this clock. */
	fetchServerTime: () => Promise<number>;
	/** Default 30 minutes. */
	maxAgeMs?: number;
}): ServerClock {
	const { now, fetchServerTime } = opts;
	const maxAgeMs = opts.maxAgeMs ?? 30 * 60_000;
	let offset = 0;
	let syncedAt: number | null = null;
	// Bumped by invalidate(): a sync started before it must not count as fresh.
	let epoch = 0;
	let pending: { epoch: number; done: Promise<void> } | null = null;

	async function measure(started: number): Promise<void> {
		const t0 = now();
		const serverTime = await fetchServerTime();
		const t1 = now();
		if (!Number.isFinite(serverTime)) {
			throw new Error("clock: server time is not a finite number");
		}
		if (started !== epoch) return; // superseded by invalidate()
		// The server read its clock somewhere in [t0, t1]; assume the midpoint.
		offset = serverTime - (t0 + t1) / 2;
		syncedAt = t1;
	}

	// Single flight per epoch: concurrent callers share one fetch. A failure
	// leaves the clock unsynced, so the next call tries again.
	function sync(): Promise<void> {
		if (pending === null || pending.epoch !== epoch) {
			const started = epoch;
			const done: Promise<void> = measure(started).finally(() => {
				if (pending?.done === done) pending = null;
			});
			pending = { epoch: started, done };
		}
		return pending.done;
	}

	return {
		async timestamp() {
			if (syncedAt === null || now() - syncedAt >= maxAgeMs) {
				// Until a sync started after the latest invalidate() has landed.
				do await sync();
				while (syncedAt === null);
			}
			return Math.round(now() + offset);
		},
		invalidate() {
			epoch++;
			syncedAt = null;
		},
	};
}

/** The timer functions a component schedules with; injected so tests run on a manual clock. */
export interface Timers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const systemTimers: Timers = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as Timer),
};
