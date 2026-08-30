/**
 * STOP key — design §12.2.
 *
 * Sends an interrupt to the active session's in-flight turn. It renders dimmed
 * when there is nothing to interrupt, so a press is never a guess.
 */

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { isInterruptible } from "../domain/session.js";
import { renderStopKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { StopActionSettings } from "./settings.js";

const CONCERNS: readonly UiConcern[] = ["session", "provider"];

@action({ UUID: "com.agentdeck.streamdeck-plus.stop" })
export class StopAction extends SingletonAction<StopActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<StopActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<StopActionSettings>): void {
		this.#subscriptions.release(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<StopActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override async onKeyDown(ev: KeyDownEvent<StopActionSettings>): Promise<void> {
		const providerId = ev.payload.settings.providerId ?? this.#runtime.defaultProviderId;
		try {
			await this.#runtime.sessions.interruptActive(providerId);
			await ev.action.showOk();
		} catch (error) {
			this.#runtime.logger.warn("stop failed", error);
			await ev.action.showAlert();
		}
	}

	#bind(target: KeyAction<StopActionSettings>, settings: StopActionSettings): void {
		bindRenderer({
			subscriptions: this.#subscriptions,
			ui: this.#runtime.ui,
			target,
			settings,
			concerns: CONCERNS,
			render: (key, current) => this.#render(key, current),
		});
	}

	async #render(target: KeyAction<StopActionSettings>, settings: StopActionSettings): Promise<void> {
		const providerId = settings.providerId ?? this.#runtime.defaultProviderId;
		const session = this.#runtime.sessions.getActiveSession(providerId);
		await target.setImage(renderStopKey(isInterruptible(session)));
	}
}
