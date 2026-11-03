import type { Credential } from "@tradedeck/core";

export function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * The error's message with every credential value cut out: a venue or the
 * keychain may echo what it was given (hard rule 1). PEM body lines are cut one
 * by one too, since an error may quote the key JSON-escaped.
 */
export function redactedMessage(e: unknown, credential: Credential): string {
	const values =
		credential.kind === "hmac"
			? [credential.apiKey, credential.secret]
			: [
					credential.apiKey,
					credential.privateKeyPem,
					...credential.privateKeyPem
						.split("\n")
						.filter((line) => !line.startsWith("-----")),
				];
	let text = message(e);
	for (const value of values) {
		// replaceAll("") would insert the marker between every character.
		if (value !== "") text = text.replaceAll(value, "[redacted]");
	}
	return text;
}
