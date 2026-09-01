/**
 * Push-to-Talk key — design §13.4, §22.3.
 *
 *   Key Down → Recording → Touch Strip: LISTENING → Key Up → Transcribe → Target Action
 *
 * Hold to talk, release to send. Holding rather than toggling is the safety
 * property: §22.3 wants the recording state unmistakable and always checkable,
 * and a key that is only live while your finger is on it cannot be left
 * recording by a missed second press.
 */

import { action } from "@elgato/streamdeck";
import type { KeyAction, KeyDownEvent, KeyUpEvent } from "@elgato/streamdeck";
import { renderVoiceKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { RenderedKeyAction } from "./rendered-key-action.js";
import type { VoiceActionSettings } from "./settings.js";

@action({ UUID: "com.agentdeck.streamdeck-plus.voice" })
export class VoiceAction extends RenderedKeyAction<VoiceActionSettings> {
	protected override get concerns(): readonly UiConcern[] {
		return ["voice", "prompt"];
	}

	/** A key that disappears mid-recording must not leave the microphone open. */
	protected override onReleased(): void {
		void this.runtime.voice.cancel();
	}

	public override async onKeyDown(ev: KeyDownEvent<VoiceActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		try {
			await this.runtime.voice.start();
		} catch (error) {
			this.runtime.logger.warn("could not start recording", error);
			await ev.action.showAlert();
		}
	}

	public override async onKeyUp(ev: KeyUpEvent<VoiceActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		const settings = ev.payload.settings;
		const activePath = this.runtime.projects.getActive()?.path;
		try {
			const result = await this.runtime.voice.stopAndRun(settings.presetId, {
				providerId: settings.providerId ?? this.runtime.defaultProviderId,
				...(activePath === undefined ? {} : { cwd: activePath }),
			});
			// Silence is not a failure, but it is not a success worth confirming.
			if (result === undefined) {
				await ev.action.showAlert();
				return;
			}
			await ev.action.showOk();
		} catch (error) {
			this.runtime.logger.warn("could not send the transcript", error);
			await ev.action.showAlert();
		}
	}

	protected override async render(target: KeyAction<VoiceActionSettings>): Promise<void> {
		await target.setImage(renderVoiceKey(this.runtime.ui.voiceViewModel()));
	}
}
