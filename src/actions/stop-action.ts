/**
 * STOP key — design §12.2.
 *
 * Sends an interrupt to the active session's in-flight turn. It renders dimmed
 * when there is nothing to interrupt, so a press is never a guess.
 */

import { action } from "@elgato/streamdeck";
import type { KeyAction, KeyDownEvent } from "@elgato/streamdeck";
import { isInterruptible } from "../domain/session.js";
import { renderStopKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { RenderedKeyAction } from "./rendered-key-action.js";
import type { StopActionSettings } from "./settings.js";

@action({ UUID: "com.agentdeck.streamdeck-plus.stop" })
export class StopAction extends RenderedKeyAction<StopActionSettings> {
	protected override get concerns(): readonly UiConcern[] {
		return ["session", "provider"];
	}

	public override async onKeyDown(ev: KeyDownEvent<StopActionSettings>): Promise<void> {
		const providerId = ev.payload.settings.providerId ?? this.runtime.defaultProviderId;
		try {
			await this.runtime.sessions.interruptActive(providerId);
			await ev.action.showOk();
		} catch (error) {
			this.runtime.logger.warn("stop failed", error);
			await ev.action.showAlert();
		}
	}

	protected override async render(
		target: KeyAction<StopActionSettings>,
		settings: StopActionSettings,
	): Promise<void> {
		const providerId = settings.providerId ?? this.runtime.defaultProviderId;
		const session = this.runtime.sessions.getActiveSession(providerId);
		await target.setImage(renderStopKey(isInterruptible(session)));
	}
}
