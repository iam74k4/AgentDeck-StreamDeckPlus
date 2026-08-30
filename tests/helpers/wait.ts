/** Polls `predicate` until it holds, so tests never depend on fixed sleeps. */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 10;
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		if (await predicate()) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(options.message ?? `Timed out after ${timeoutMs}ms waiting for condition`);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
