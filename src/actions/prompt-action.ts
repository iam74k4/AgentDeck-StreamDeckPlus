/**
 * Prompt key — design §14, §15.
 *
 * Runs one preset: it gathers the input the preset asks for, fills the template
 * and sends the result. The key names the preset and where its input comes from,
 * because a press that reads the clipboard should not be a surprise.
 *
 * Design §22.4 — the press is the trigger. Nothing here runs on a timer.
 */

import { action } from "@elgato/streamdeck";
import type { KeyAction, KeyDownEvent } from "@elgato/streamdeck";
import { renderPromptKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { buildPromptViewModel } from "../presentation/view-models/prompt.js";
import { RenderedKeyAction } from "./rendered-key-action.js";
import type { PromptActionSettings } from "./settings.js";

@action({ UUID: "com.agentdeck.streamdeck-plus.prompt" })
export class PromptAction extends RenderedKeyAction<PromptActionSettings> {
	protected override get concerns(): readonly UiConcern[] {
		return ["prompt", "session", "project"];
	}

	public override async onKeyDown(ev: KeyDownEvent<PromptActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		const settings = ev.payload.settings;
		try {
			await this.runtime.prompts.run(settings.presetId, {
				providerId: settings.providerId ?? this.runtime.defaultProviderId,
				...(this.runtime.projects.getActive()?.path === undefined
					? {}
					: { cwd: this.runtime.projects.getActive()?.path }),
				...(typeof settings.text === "string" && settings.text.trim().length > 0
					? { text: settings.text }
					: {}),
			});
			await ev.action.showOk();
		} catch (error) {
			// The message can quote what could not be sent, so only the code travels.
			this.runtime.logger.warn("prompt failed", error);
			await ev.action.showAlert();
		}
	}

	protected override async render(
		target: KeyAction<PromptActionSettings>,
		settings: PromptActionSettings,
	): Promise<void> {
		const preset = this.runtime.prompts.get(settings.presetId);
		await target.setImage(renderPromptKey(buildPromptViewModel(preset === undefined ? {} : { preset })));
	}
}
