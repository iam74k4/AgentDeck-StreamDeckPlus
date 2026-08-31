/**
 * Agent Status key — design §12.1.
 *
 *   CODEX
 *   ● WORKING
 *   02:18
 */

import streamDeck, { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { renderAgentStatusKey } from "../presentation/renderers/key-renderer.js";
import { buildAgentStatusViewModel } from "../presentation/view-models/agent-status.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { AgentStatusActionSettings } from "./settings.js";

/** `tick` keeps the elapsed-time readout moving while a turn runs. */
const CONCERNS: readonly UiConcern[] = ["session", "provider", "usage", "tick"];

@action({ UUID: "com.agentdeck.streamdeck-plus.agent-status" })
export class AgentStatusAction extends SingletonAction<AgentStatusActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<AgentStatusActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<AgentStatusActionSettings>): void {
		this.#subscriptions.release(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<AgentStatusActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	/** A press re-reads the session list; it never starts or stops anything. */
	public override async onKeyDown(ev: KeyDownEvent<AgentStatusActionSettings>): Promise<void> {
		try {
			await this.#runtime.sessions.refresh();
			await ev.action.showOk();
		} catch (error) {
			this.#runtime.logger.warn("failed to refresh sessions", error);
			await ev.action.showAlert();
		}
	}

	#bind(target: KeyAction<AgentStatusActionSettings>, settings: AgentStatusActionSettings): void {
		bindRenderer({
			subscriptions: this.#subscriptions,
			ui: this.#runtime.ui,
			target,
			settings,
			concerns: CONCERNS,
			render: (key, current) => this.#render(key, current),
		});
	}

	async #render(
		target: KeyAction<AgentStatusActionSettings>,
		settings: AgentStatusActionSettings,
	): Promise<void> {
		const providerId = settings.providerId ?? this.#runtime.defaultProviderId;
		const provider = this.#runtime.registry.get(providerId);
		const snapshot = this.#runtime.ui.getUsageSnapshot(providerId);

		const session =
			settings.sessionMode === "fixed" && settings.sessionId !== undefined
				? this.#runtime.sessions.list(providerId).find((candidate) => candidate.id === settings.sessionId)
				: this.#runtime.sessions.getActiveSession(providerId);

		const viewModel = buildAgentStatusViewModel({
			providerLabel: provider?.displayName ?? providerId,
			providerStatus: snapshot?.status ?? "loading",
			...(snapshot?.error === undefined ? {} : { errorCode: snapshot.error.code }),
			session,
		});

		try {
			await target.setImage(renderAgentStatusKey(viewModel));
		} catch (error) {
			streamDeck.logger.debug("failed to set agent status image", error);
		}
	}
}
