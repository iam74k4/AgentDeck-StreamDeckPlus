/**
 * Usage service — design §17.
 *
 * One shared cache and one in-flight request per provider, so eight keys and four
 * dials reading the same provider produce exactly one call (design §17.1, §17.2).
 * The last successful snapshot is retained so a failure degrades to STALE rather
 * than to a blank key (design §27).
 */

import type { Unsubscribe } from "../domain/provider-events.js";
import { toAgentDeckError } from "../domain/errors.js";
import { mostConstrainedWindow, providerStatusForError } from "../domain/usage.js";
import type { ProviderId, UsageSnapshot, UsageWindow } from "../domain/usage.js";
import { Throttle } from "../infrastructure/backoff.js";
import type { Logger } from "../infrastructure/logger.js";
import { SingleFlight } from "../infrastructure/single-flight.js";
import type { ProviderRegistry } from "./provider-registry.js";

export type UsageListener = (snapshot: UsageSnapshot) => void;

export interface UsageServiceOptions {
	logger?: Logger;
	/** Minimum spacing between user-initiated refreshes of one provider (design §21.3). */
	manualRefreshThrottleMs?: number;
	now?: () => Date;
}

/** One row of the AI Overview (design §18) — never a cross-provider sum. */
export interface ProviderOverviewEntry {
	providerId: ProviderId;
	displayName: string;
	status: UsageSnapshot["status"];
	window?: UsageWindow;
}

export class UsageService {
	readonly #registry: ProviderRegistry;
	readonly #cache = new Map<ProviderId, UsageSnapshot>();
	readonly #listeners = new Set<UsageListener>();
	readonly #singleFlight = new SingleFlight<ProviderId>();
	readonly #throttles = new Map<ProviderId, Throttle>();
	readonly #logger: Logger | undefined;
	readonly #manualRefreshThrottleMs: number;
	readonly #now: () => Date;
	#unsubscribe: Unsubscribe | undefined;

	public constructor(registry: ProviderRegistry, options: UsageServiceOptions = {}) {
		this.#registry = registry;
		this.#logger = options.logger?.child("usage");
		this.#manualRefreshThrottleMs = options.manualRefreshThrottleMs ?? 2_000;
		this.#now = options.now ?? (() => new Date());

		// Push path: providers report usage changes, the service never polls for them.
		this.#unsubscribe = registry.subscribe((event) => {
			if (event.type === "usage-updated") {
				this.#store(event.snapshot);
			}
		});
	}

	public subscribe(listener: UsageListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public getSnapshot(providerId: ProviderId): UsageSnapshot | undefined {
		return this.#cache.get(providerId);
	}

	public snapshots(): UsageSnapshot[] {
		return [...this.#cache.values()];
	}

	/**
	 * Refreshes one provider.
	 *
	 * @param manual `true` for a user-initiated refresh, which is allowed during
	 * backoff but throttled against key mashing (design §21.3).
	 */
	public async refresh(providerId: ProviderId, options: { manual?: boolean } = {}): Promise<UsageSnapshot> {
		if (options.manual === true && !this.#throttle(providerId).tryAcquire()) {
			this.#logger?.debug(`manual refresh throttled for ${providerId}`);
			return this.#cache.get(providerId) ?? this.#emptySnapshot(providerId, "loading");
		}

		return this.#singleFlight.run(providerId, async () => {
			const provider = this.#registry.get(providerId);
			if (provider?.refreshUsage === undefined) {
				const snapshot = this.#cache.get(providerId) ?? this.#emptySnapshot(providerId, "error");
				return snapshot;
			}
			try {
				const snapshot = await provider.refreshUsage();
				this.#store(snapshot);
				return snapshot;
			} catch (error) {
				const degraded = this.#degrade(providerId, error);
				this.#store(degraded);
				return degraded;
			}
		});
	}

	public refreshAll(options: { manual?: boolean } = {}): Promise<UsageSnapshot[]> {
		return Promise.all(this.#registry.ids.map((id) => this.refresh(id, options)));
	}

	/**
	 * AI Overview rows — design §18.
	 *
	 * Providers are listed side by side; usage is never summed into an "AI Total".
	 */
	public overview(): ProviderOverviewEntry[] {
		return this.#registry.list().map((provider) => {
			const snapshot = this.#cache.get(provider.id);
			const window = snapshot === undefined ? undefined : mostConstrainedWindow(snapshot.windows);
			return {
				providerId: provider.id,
				displayName: provider.displayName,
				status: snapshot?.status ?? "loading",
				...(window === undefined ? {} : { window }),
			};
		});
	}

	public dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#listeners.clear();
		this.#cache.clear();
	}

	#throttle(providerId: ProviderId): Throttle {
		let throttle = this.#throttles.get(providerId);
		if (throttle === undefined) {
			throttle = new Throttle(this.#manualRefreshThrottleMs);
			this.#throttles.set(providerId, throttle);
		}
		return throttle;
	}

	/** Design §17.3 — failure with a cache is STALE, failure without one is ERROR. */
	#degrade(providerId: ProviderId, error: unknown): UsageSnapshot {
		const agentDeckError = toAgentDeckError(error);
		const cached = this.#cache.get(providerId);
		const status = providerStatusForError(
			agentDeckError.code,
			cached !== undefined && cached.windows.length > 0,
		);

		const snapshot: UsageSnapshot = {
			providerId,
			status,
			fetchedAt: this.#now(),
			windows: cached?.windows ?? [],
			error: { code: agentDeckError.code, message: agentDeckError.message },
		};
		if (cached?.lastSuccessAt !== undefined) {
			snapshot.lastSuccessAt = cached.lastSuccessAt;
		}
		return snapshot;
	}

	#emptySnapshot(providerId: ProviderId, status: UsageSnapshot["status"]): UsageSnapshot {
		return { providerId, status, fetchedAt: this.#now(), windows: [] };
	}

	#store(snapshot: UsageSnapshot): void {
		this.#cache.set(snapshot.providerId, snapshot);
		for (const listener of this.#listeners) {
			try {
				listener(snapshot);
			} catch (error) {
				this.#logger?.warn("usage listener failed", error);
			}
		}
	}
}
