/**
 * Exponential backoff with jitter — design §21.3.
 */

export interface BackoffOptions {
	initialDelayMs?: number;
	maxDelayMs?: number;
	factor?: number;
	/** Fraction of the delay applied as random jitter, 0–1. */
	jitter?: number;
	/** Injectable for deterministic tests. */
	random?: () => number;
}

export class Backoff {
	readonly #initialDelayMs: number;
	readonly #maxDelayMs: number;
	readonly #factor: number;
	readonly #jitter: number;
	readonly #random: () => number;
	#attempt = 0;

	public constructor(options: BackoffOptions = {}) {
		this.#initialDelayMs = options.initialDelayMs ?? 1_000;
		this.#maxDelayMs = options.maxDelayMs ?? 60_000;
		this.#factor = options.factor ?? 2;
		this.#jitter = options.jitter ?? 0.2;
		this.#random = options.random ?? Math.random;
	}

	public get attempt(): number {
		return this.#attempt;
	}

	/** Returns the delay for the next retry and advances the attempt counter. */
	public next(): number {
		const raw = this.#initialDelayMs * Math.pow(this.#factor, this.#attempt);
		this.#attempt += 1;
		const capped = Math.min(this.#maxDelayMs, raw);
		const spread = capped * this.#jitter;
		const delta = (this.#random() * 2 - 1) * spread;
		return Math.max(0, Math.round(capped + delta));
	}

	public reset(): void {
		this.#attempt = 0;
	}
}

/**
 * Rate limiter for user-initiated refreshes.
 *
 * Design §21.3: a manual refresh is allowed even while the provider is backing
 * off, but repeated mashing of the key is throttled.
 */
export class Throttle {
	readonly #intervalMs: number;
	readonly #now: () => number;
	#lastAt = Number.NEGATIVE_INFINITY;

	public constructor(intervalMs: number, now: () => number = Date.now) {
		this.#intervalMs = intervalMs;
		this.#now = now;
	}

	public tryAcquire(): boolean {
		const now = this.#now();
		if (now - this.#lastAt < this.#intervalMs) {
			return false;
		}
		this.#lastAt = now;
		return true;
	}
}
