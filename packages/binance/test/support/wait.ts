/**
 * Resolves once `done()` holds. Polls because the awaited state is reached
 * through promise chains (fetch, signing) that expose no single signal.
 */
export async function until(
	done: () => boolean,
	timeoutMs = 1000,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!done()) {
		if (performance.now() > deadline) {
			throw new Error(`until: not met within ${timeoutMs} ms`);
		}
		await Bun.sleep(1);
	}
}
