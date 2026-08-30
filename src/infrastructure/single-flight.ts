/**
 * Single-flight coalescing — design §17.2, §27.
 *
 * Several actions can ask for the same provider's usage at once; only one request
 * may actually leave the process.
 */

export class SingleFlight<TKey = string> {
	readonly #inflight = new Map<TKey, Promise<unknown>>();

	/** Runs `task`, or joins the in-flight run for the same `key`. */
	public run<T>(key: TKey, task: () => Promise<T>): Promise<T> {
		const existing = this.#inflight.get(key);
		if (existing !== undefined) {
			return existing as Promise<T>;
		}
		const promise = (async () => task())().finally(() => {
			this.#inflight.delete(key);
		});
		this.#inflight.set(key, promise);
		return promise;
	}

	public isRunning(key: TKey): boolean {
		return this.#inflight.has(key);
	}

	public get size(): number {
		return this.#inflight.size;
	}
}
