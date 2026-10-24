import { VenueError } from "@tradedeck/adapter";
import { z } from "zod";
import type { Endpoint } from "./endpoints.ts";

/**
 * Parses a venue response, or rejects with a `decode` VenueError naming the
 * endpoint and the failing field path. An unknown enum value lands here too:
 * a snapshot fails loudly rather than silently dropping, say, an open order.
 */
export function decode<T>(
	schema: z.ZodType<T>,
	body: unknown,
	endpoint: Pick<Endpoint, "method" | "path">,
): T {
	const result = schema.safeParse(body);
	if (result.success) return result.data;
	const issue = result.error.issues[0];
	const at = issue === undefined ? "" : issue.path.join(".");
	throw new VenueError({
		kind: "decode",
		method: endpoint.method,
		path: endpoint.path,
		status: null,
		code: null,
		retryAfterMs: null,
		text: `unexpected response at ${at === "" ? "<root>" : at}: ${issue?.message ?? "invalid"}`,
	});
}

/**
 * A venue enum mapped to its domain value. A value missing from `map` is a
 * decode error naming it, so a new Binance value surfaces instead of being
 * guessed at.
 */
export function venueEnum<const M extends Readonly<Record<string, unknown>>>(
	map: M,
	what: string,
) {
	return z.string().transform((value, ctx): M[keyof M] => {
		if (Object.hasOwn(map, value)) return map[value as keyof M];
		ctx.addIssue({
			code: "custom",
			message: `unknown ${what} "${value.slice(0, 40)}"`,
		});
		return z.NEVER;
	});
}
