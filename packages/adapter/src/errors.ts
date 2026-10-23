/**
 * - `http`: the venue answered with a non-2xx status.
 * - `network`: the request failed before a response arrived.
 * - `timeout`: no complete response within the request timeout. The outcome
 *   is unknown: an order request may still have reached the venue.
 * - `decode`: a 2xx response whose body is not JSON.
 */
export type VenueErrorKind = "http" | "network" | "timeout" | "decode";

/**
 * A failed venue request. Neither the message nor any field carries the query
 * string, headers, API key or signature; `path` is the bare request path.
 */
export class VenueError extends Error {
	override readonly name = "VenueError";
	readonly kind: VenueErrorKind;
	readonly method: string;
	readonly path: string;
	readonly status: number | null;
	/** The venue's own error code as a string, e.g. `"-1121"`. */
	readonly code: string | null;
	/** From `Retry-After` on 429/418, in milliseconds. */
	readonly retryAfterMs: number | null;

	constructor(init: {
		kind: VenueErrorKind;
		method: string;
		path: string;
		status: number | null;
		code: string | null;
		retryAfterMs: number | null;
		/** The venue's message when it sent one, else a description of the failure. */
		text: string;
	}) {
		const head = `${init.status ?? init.kind}${init.code === null ? "" : ` ${init.code}`}`;
		super(`${init.method} ${init.path} → ${head}: ${init.text}`);
		this.kind = init.kind;
		this.method = init.method;
		this.path = init.path;
		this.status = init.status;
		this.code = init.code;
		this.retryAfterMs = init.retryAfterMs;
	}
}
