/**
 * Prompt key — design §14, §15.
 *
 * Runs one preset: it gathers the input the preset asks for, fills the template
 * and sends the result. The key names the preset and where its input comes from,
 * because a press that reads the clipboard should not be a surprise.
 *
 * Design §22.4 — the press is the trigger. Nothing here runs on a timer.
 */

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { renderPromptKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { buildPromptViewModel } from "../presentation/view-models/prompt.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { PromptActionSettings } from "./settings.js";

const CONCERNS: readonly UiConcern[] = ["prompt", "session", "project"];

@action({ UUID: "com.agentdeck.streamdeck-plus.prompt" })
export class PromptAction extends SingletonAction<PromptActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<PromptActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<PromptActionSettings>): void {
		this.#subscriptions.release(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<PromptActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override async onKeyDown(ev: KeyDownEvent<PromptActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		const settings = ev.payload.settings;
		try {
			await this.#runtime.prompts.run(settings.presetId, {
				providerId: settings.providerId ?? this.#runtime.defaultProviderId,
				...(this.#runtime.projects.getActive()?.path === undefined
					? {}
					: { cwd: this.#runtime.projects.getActive()?.path }),
				...(typeof settings.text === "string" && settings.text.trim().length > 0
					? { text: settings.text }
					: {}),
			});
			await ev.action.showOk();
		} catch (error) {
			// The message can quote what could not be sent, so only the code travels.
			this.#runtime.logger.warn("prompt failed", error);
			await ev.action.showAlert();
		}
	}

	#bind(target: KeyAction<PromptActionSettings>, settings: PromptActionSettings): void {
		bindRenderer({
			subscriptions: this.#subscriptions,
			ui: this.#runtime.ui,
			target,
			settings,
			concerns: CONCERNS,
			render: (key, current) => this.#render(key, current),
		});
	}

	async #render(target: KeyAction<PromptActionSettings>, settings: PromptActionSettings): Promise<void> {
		const preset = this.#runtime.prompts.get(settings.presetId);
		await target.setImage(renderPromptKey(buildPromptViewModel(preset === undefined ? {} : { preset })));
	}
}
