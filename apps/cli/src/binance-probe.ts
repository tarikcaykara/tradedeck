import { systemTimers } from "@tradedeck/adapter";
import {
	createBinanceHttp,
	type Host,
	measureClockOffset,
	probeUserStream,
	verifyCredential,
	withinRecvWindow,
} from "@tradedeck/binance";
import type { Credential } from "@tradedeck/core";
import type { AccountRow } from "@tradedeck/db";
import type { AccountProbe } from "./doctor.ts";

/** Covers the spot subscription's own 10 s answer timeout. */
const STREAM_TIMEOUT_MS = 15_000;
const HOSTS: readonly Host[] = ["spot", "futures"];

/**
 * The real readings for a Binance account: the public time endpoints, the
 * credential check and both private user-data streams.
 */
export function binanceProbe(
	account: AccountRow,
	credential: Credential,
): AccountProbe<Host> {
	const { environment } = account;
	const http = createBinanceHttp({ environment, credential });
	const streamDeps = { environment, http, now: Date.now, timers: systemTimers };
	return {
		hosts: HOSTS,
		async clockOffset(host) {
			const offsetMs = await measureClockOffset(http, host, Date.now);
			return { offsetMs, accepted: withinRecvWindow(offsetMs) };
		},
		verifyCredential: () => verifyCredential(http, environment),
		streams: HOSTS,
		probeStream: (name) => probeUserStream(name, streamDeps, STREAM_TIMEOUT_MS),
	};
}
