import { isCancel, log, password, text } from "@clack/prompts";

/** Every line a command shows or asks goes through here, so tests capture it all. */
export interface Io {
	/** Raw text to stdout, newline appended (PEM blocks, tables, the report). */
	print(text: string): void;
	step(text: string): void;
	success(text: string): void;
	warn(text: string): void;
	error(text: string): void;
	/** Hidden input; null when the user cancels (Ctrl-C / Esc). */
	secret(message: string): Promise<string | null>;
	/** Visible input; null when the user cancels. */
	text(message: string): Promise<string | null>;
}

export function clackIo(): Io {
	return {
		print: (value) => {
			process.stdout.write(`${value}\n`);
		},
		step: (value) => log.step(value),
		success: (value) => log.success(value),
		warn: (value) => log.warn(value),
		error: (value) => log.error(value),
		secret: async (message) => {
			const value = await password({
				message,
				validate: (v) => (v ? undefined : "Required"),
			});
			return isCancel(value) ? null : value;
		},
		text: async (message) => {
			const value = await text({ message });
			return isCancel(value) ? null : value;
		},
	};
}
