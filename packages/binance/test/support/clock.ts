import type { Timers } from "@tradedeck/adapter";

export interface ManualClock {
	now(): number;
	timers: Timers;
	/**
	 * Runs every timer due up to `now() + ms` in time order (ties in creation
	 * order), with `now` at each timer's time, settling pending promises before
	 * each one, so async continuations and the timers they create run too.
	 */
	advance(ms: number): Promise<void>;
	/** Timers armed and not yet run or cleared. */
	pending(): number;
}

interface Due {
	at: number;
	seq: number;
	fn: () => void;
}

/** Lets every pending promise continuation and microtask run. */
function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** A clock whose time moves only through `advance`. */
export function manualClock(start = 1_800_000_000_000): ManualClock {
	let t = start;
	let seq = 0;
	const due = new Map<number, Due>();
	return {
		now: () => t,
		timers: {
			setTimeout(fn, ms) {
				const id = ++seq;
				due.set(id, { at: t + Math.max(0, ms), seq: id, fn });
				return id;
			},
			clearTimeout(handle) {
				due.delete(handle as number);
			},
		},
		async advance(ms) {
			const end = t + ms;
			for (;;) {
				await settle();
				let next: Due | undefined;
				for (const d of due.values()) {
					if (d.at > end) continue;
					if (
						next === undefined ||
						d.at < next.at ||
						(d.at === next.at && d.seq < next.seq)
					) {
						next = d;
					}
				}
				if (next === undefined) break;
				due.delete(next.seq);
				t = next.at;
				next.fn();
			}
			t = end;
			await settle();
		},
		pending: () => due.size,
	};
}
