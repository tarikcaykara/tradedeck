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
	let pending: Promise<void> | null = null;

	async function measure(): Promise<void> {
		const t0 = now();
		const serverTime = await fetchServerTime();
		const t1 = now();
		if (!Number.isFinite(serverTime)) {
			throw new Error("clock: server time is not a finite number");
		}
		// The server read its clock somewhere in [t0, t1]; assume the midpoint.
		offset = serverTime - (t0 + t1) / 2;
		syncedAt = t1;
	}

	// Single flight: concurrent callers share one fetch. A failure leaves the
	// clock unsynced, so the next call tries again.
	function sync(): Promise<void> {
		pending ??= measure().finally(() => {
			pending = null;
		});
		return pending;
	}

	return {
		async timestamp() {
			if (syncedAt === null || now() - syncedAt >= maxAgeMs) await sync();
			return Math.round(now() + offset);
		},
		invalidate() {
			syncedAt = null;
		},
	};
}
