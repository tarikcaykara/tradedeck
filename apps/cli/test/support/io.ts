import type { Io } from "../../src/io.ts";

export interface FakeIo {
	io: Io;
	/** Every line shown or asked, in order. */
	out: string[];
	/** Answers not yet taken. */
	queue: string[];
}

/**
 * Captures every line shown or asked; answers come from a queue, empty = cancel.
 * `interactive` stands for a TTY stdin.
 */
export function fakeIo(
	answers: readonly string[] = [],
	interactive = true,
): FakeIo {
	const out: string[] = [];
	const queue = [...answers];
	const show = (text: string) => {
		out.push(text);
	};
	const ask = async (message: string) => {
		out.push(message);
		return queue.shift() ?? null;
	};
	const io: Io = {
		interactive,
		print: show,
		step: show,
		success: show,
		warn: show,
		error: show,
		secret: ask,
		text: ask,
	};
	return { io, out, queue };
}
