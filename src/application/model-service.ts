/**
 * Model / reasoning selector state — design §19.
 *
 * The model list is never hard-coded: it comes from whichever provider is being
 * shown, and a provider that cannot report one leaves the selector disabled
 * rather than offering a choice that would fail on press.
 *
 * Rotating moves a highlight; only a press applies it. That separation is the
 * whole point of the dial in design §6.1 — a nudge while reaching past the deck
 * must not change the model a running agent is using.
 */

import { AgentDeckError, toAgentDeckError } from "../domain/errors.js";
import { isSameSelection, modelChoices, type ModelDescriptor, type ModelSelection } from "../domain/model.js";
import type { Unsubscribe } from "../domain/provider-events.js";
import type { ProviderId } from "../domain/usage.js";
import type { Logger } from "../infrastructure/logger.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { SessionService } from "./session-service.js";

export interface ModelState {
	providerId: ProviderId;
	/** False when the provider reports no models or cannot apply one. */
	supported: boolean;
	models: readonly ModelDescriptor[];
	choices: readonly ModelSelection[];
	/** Where the dial is pointing. Not applied until the dial is pressed. */
	highlighted: ModelSelection | undefined;
	/** What the active session is actually running, when the provider says. */
	applied: ModelSelection | undefined;
	loading: boolean;
	error: AgentDeckError | undefined;
}

export type ModelListener = (providerId: ProviderId) => void;

export interface ModelServiceOptions {
	logger?: Logger;
}

interface ProviderModels {
	models: ModelDescriptor[];
	choices: ModelSelection[];
	highlightIndex: number;
	loading: boolean;
	loaded: boolean;
	error: AgentDeckError | undefined;
}

function emptyEntry(): ProviderModels {
	return { models: [], choices: [], highlightIndex: 0, loading: false, loaded: false, error: undefined };
}

export class ModelService {
	readonly #registry: ProviderRegistry;
	readonly #sessions: SessionService;
	readonly #logger: Logger | undefined;
	readonly #listeners = new Set<ModelListener>();
	readonly #byProvider = new Map<ProviderId, ProviderModels>();
	readonly #inFlight = new Map<ProviderId, Promise<void>>();

	public constructor(
		registry: ProviderRegistry,
		sessions: SessionService,
		options: ModelServiceOptions = {},
	) {
		this.#registry = registry;
		this.#sessions = sessions;
		this.#logger = options.logger?.child("model");
	}

	public subscribe(listener: ModelListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public getState(providerId: ProviderId): ModelState {
		const entry = this.#byProvider.get(providerId) ?? emptyEntry();
		const provider = this.#registry.get(providerId);
		const session = this.#sessions.getActiveSession(providerId);
		const applied: ModelSelection | undefined =
			session?.modelId === undefined
				? undefined
				: {
						modelId: session.modelId,
						...(session.reasoningLevel === undefined ? {} : { reasoningLevel: session.reasoningLevel }),
					};

		return {
			providerId,
			// Design §19: a provider that cannot list or apply models disables the action.
			supported: provider?.getModels !== undefined && provider.applyModel !== undefined,
			models: entry.models,
			choices: entry.choices,
			highlighted: entry.choices[entry.highlightIndex],
			applied,
			loading: entry.loading,
			error: entry.error,
		};
	}

	/**
	 * Loads the model list, once per provider.
	 *
	 * Concurrent callers share the in-flight request (design §17.2), so four
	 * encoders appearing at once do not make four `model/list` calls.
	 */
	public async refresh(providerId: ProviderId, options: { force?: boolean } = {}): Promise<void> {
		const existing = this.#inFlight.get(providerId);
		if (existing !== undefined) {
			return existing;
		}
		const entry = this.#entry(providerId);
		if (entry.loaded && options.force !== true) {
			return;
		}
		const provider = this.#registry.get(providerId);
		if (provider?.getModels === undefined) {
			entry.loaded = true;
			return;
		}

		entry.loading = true;
		entry.error = undefined;
		this.#notify(providerId);

		const run = (async (): Promise<void> => {
			try {
				const models = await provider.getModels!();
				entry.models = models;
				entry.choices = modelChoices(models);
				entry.highlightIndex = this.#indexOfApplied(providerId, entry);
				entry.loaded = true;
			} catch (error) {
				entry.error = toAgentDeckError(error);
				this.#logger?.debug(`model/list failed for ${providerId}`, error);
			} finally {
				entry.loading = false;
				this.#inFlight.delete(providerId);
				this.#notify(providerId);
			}
		})();
		this.#inFlight.set(providerId, run);
		return run;
	}

	/** Rotation moves the highlight and nothing else (design §19 "Rotate"). */
	public rotate(providerId: ProviderId, delta: number): void {
		const entry = this.#entry(providerId);
		if (entry.choices.length === 0) {
			void this.refresh(providerId);
			return;
		}
		const count = entry.choices.length;
		entry.highlightIndex = (((entry.highlightIndex + delta) % count) + count) % count;
		this.#notify(providerId);
	}

	/** Design §19 "Press → Apply". */
	public async apply(providerId: ProviderId): Promise<ModelSelection> {
		const entry = this.#entry(providerId);
		const selection = entry.choices[entry.highlightIndex];
		if (selection === undefined) {
			throw new AgentDeckError("PROTOCOL_ERROR", "No model to apply yet.");
		}
		const provider = this.#registry.get(providerId);
		if (provider?.applyModel === undefined) {
			throw new AgentDeckError("PROTOCOL_ERROR", `Provider ${providerId} cannot change model.`);
		}
		const session = this.#sessions.getActiveSession(providerId);
		if (session === undefined) {
			throw new AgentDeckError("PROTOCOL_ERROR", "No session to apply the model to.");
		}

		await provider.applyModel(session.id, selection);
		this.#logger?.info(`applied model for ${providerId}`);
		this.#notify(providerId);
		return selection;
	}

	public dispose(): void {
		this.#listeners.clear();
		this.#byProvider.clear();
		this.#inFlight.clear();
	}

	#entry(providerId: ProviderId): ProviderModels {
		let entry = this.#byProvider.get(providerId);
		if (entry === undefined) {
			entry = emptyEntry();
			this.#byProvider.set(providerId, entry);
		}
		return entry;
	}

	/** Start the highlight where the session already is, not at the top of the list. */
	#indexOfApplied(providerId: ProviderId, entry: ProviderModels): number {
		const applied = this.getState(providerId).applied;
		if (applied === undefined) {
			return 0;
		}
		const exact = entry.choices.findIndex((choice) => isSameSelection(choice, applied));
		if (exact >= 0) {
			return exact;
		}
		// The session may report a model without an effort, or one this list does
		// not carry; landing on the same model is still closer than landing on none.
		const sameModel = entry.choices.findIndex((choice) => choice.modelId === applied.modelId);
		return sameModel >= 0 ? sameModel : 0;
	}

	#notify(providerId: ProviderId): void {
		for (const listener of this.#listeners) {
			try {
				listener(providerId);
			} catch (error) {
				this.#logger?.warn("model listener failed", error);
			}
		}
	}
}
