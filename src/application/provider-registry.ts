/**
 * Provider registry — design §8.1.
 *
 * Providers register themselves; nothing here knows the concrete set. A failing
 * provider is isolated: `startAll` never rejects because one provider is broken
 * (design §27 "Provider障害でPlugin全体を停止しない").
 */

import type { ProviderEvent, Unsubscribe } from "../domain/provider-events.js";
import type { ProviderId } from "../domain/usage.js";
import type { AgentProvider } from "../providers/provider.js";
import type { Logger } from "../infrastructure/logger.js";

/**
 * Registry listeners are told which provider raised the event.
 *
 * A provider's own listener does not need it — it knows — but a consumer of the
 * whole registry does: session ids and approval ids are only unique per
 * provider, so acting on one by id alone can act on another provider's.
 */
export type RegistryEventListener = (event: ProviderEvent, providerId: ProviderId) => void;

export interface ProviderStartResult {
	providerId: ProviderId;
	started: boolean;
	error?: unknown;
}

export class ProviderRegistry {
	readonly #providers = new Map<ProviderId, AgentProvider>();
	readonly #listeners = new Set<RegistryEventListener>();
	readonly #unsubscribes = new Map<ProviderId, Unsubscribe>();
	readonly #logger: Logger | undefined;

	public constructor(logger?: Logger) {
		this.#logger = logger?.child("registry");
	}

	public register(provider: AgentProvider): void {
		if (this.#providers.has(provider.id)) {
			throw new Error(`Provider already registered: ${provider.id}`);
		}
		this.#providers.set(provider.id, provider);
		this.#unsubscribes.set(
			provider.id,
			provider.subscribe((event) => this.#fanOut(event, provider.id)),
		);
		this.#logger?.info(`registered provider ${provider.id}`);
	}

	public get(id: ProviderId): AgentProvider | undefined {
		return this.#providers.get(id);
	}

	public list(): AgentProvider[] {
		return [...this.#providers.values()];
	}

	public get ids(): ProviderId[] {
		return [...this.#providers.keys()];
	}

	/** Subscribes to every provider's events. */
	public subscribe(listener: RegistryEventListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public async startAll(): Promise<ProviderStartResult[]> {
		return Promise.all(
			this.list().map(async (provider): Promise<ProviderStartResult> => {
				try {
					await provider.start();
					return { providerId: provider.id, started: true };
				} catch (error) {
					this.#logger?.warn(`provider ${provider.id} failed to start`, error);
					return { providerId: provider.id, started: false, error };
				}
			}),
		);
	}

	public async stopAll(): Promise<void> {
		await Promise.all(
			this.list().map(async (provider) => {
				try {
					await provider.stop();
				} catch (error) {
					this.#logger?.warn(`provider ${provider.id} failed to stop cleanly`, error);
				}
			}),
		);
		for (const unsubscribe of this.#unsubscribes.values()) {
			unsubscribe();
		}
		this.#unsubscribes.clear();
		this.#listeners.clear();
	}

	#fanOut(event: ProviderEvent, providerId: ProviderId): void {
		for (const listener of this.#listeners) {
			try {
				listener(event, providerId);
			} catch (error) {
				this.#logger?.warn("registry listener failed", error);
			}
		}
	}
}
