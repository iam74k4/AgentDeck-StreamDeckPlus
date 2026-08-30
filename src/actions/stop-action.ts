/**
 * STOP key — design §12.2.
 *
 * Sends an interrupt to the active session's in-flight turn. It renders dimmed
 * when there is nothing to interrupt, so a press is never a guess.
 */

import { action, SingletonAction } from "@elgato/streamdeck";
import type { KeyAction, KeyDownEvent, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { isInterruptible } from "../domain/session.js";
import { renderStopKey } from "../presentation/renderers/key-renderer.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import type { StopActionSettings } from "./settings.js";

@action({ UUID: "com.agentdeck.streamdeck-plus.stop" })
export class StopAction extends SingletonAction<StopActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<StopActionSettings>): void {
		if (!ev.action.isKey()) {
			return;
		}
		const target = ev.action;
		const redraw = (): void => void this.#render(target, ev.payload.settings);

		this.#subscriptions.add(
			ev.action.id,
			this.#runtime.ui.subscribe("session", redraw),
			this.#runtime.ui.subscribe("provider", redraw),
		);
		redraw();
	}

	public override onWillDisappear(ev: WillDisappearEvent<StopActionSettings>): void {
		this.#subscriptions.release(ev.action.id);
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

	async #render(target: KeyAction<StopActionSettings>, settings: StopActionSettings): Promise<void> {
		const providerId = settings.providerId ?? this.#runtime.defaultProviderId;
		const session = this.#runtime.sessions.getActiveSession(providerId);
		await target.setImage(renderStopKey(isInterruptible(session)));
	}
}
