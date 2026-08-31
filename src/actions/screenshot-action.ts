/**
 * Screenshot → AI — design §15.1, §22.4.
 *
 * Captures the active window or the whole screen and sends it to the agent with
 * a prompt. §22.4 governs both ends: the press is the only trigger, and the
 * temporary file is deleted as soon as the send finishes, successfully or not.
 *
 * AgentDeck never keeps the image (§15.1 "Stream Deckにはスクリーンショット自体を
 * 常時保持しない") and never logs it (instructions §11).
 */

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import type { ScreenshotMode } from "../adapters/desktop/screenshot.js";
import { renderPromptKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { buildPromptViewModel } from "../presentation/view-models/prompt.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { ScreenshotActionSettings } from "./settings.js";

const CONCERNS: readonly UiConcern[] = ["prompt", "session"];

/** Design §15.1 — Selected Region is listed as future work and is not offered. */
export function captureMode(settings: ScreenshotActionSettings): ScreenshotMode {
	return settings.captureMode === "full-screen" ? "full-screen" : "active-window";
}

@action({ UUID: "com.agentdeck.streamdeck-plus.screenshot" })
export class ScreenshotAction extends SingletonAction<ScreenshotActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<ScreenshotActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<ScreenshotActionSettings>): void {
		this.#subscriptions.release(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ScreenshotActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override async onKeyDown(ev: KeyDownEvent<ScreenshotActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		const settings = ev.payload.settings;
		const activePath = this.#runtime.projects.getActive()?.path;
		try {
			await this.#runtime.prompts.run(settings.presetId ?? "explain-screen", {
				providerId: settings.providerId ?? this.#runtime.defaultProviderId,
				screenshotMode: captureMode(settings),
				...(activePath === undefined ? {} : { cwd: activePath }),
			});
			await ev.action.showOk();
		} catch (error) {
			this.#runtime.logger.warn("screenshot failed", error);
			await ev.action.showAlert();
		}
	}

	#bind(target: KeyAction<ScreenshotActionSettings>, settings: ScreenshotActionSettings): void {
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
		target: KeyAction<ScreenshotActionSettings>,
		settings: ScreenshotActionSettings,
	): Promise<void> {
		const preset = this.#runtime.prompts.get(settings.presetId ?? "explain-screen");
		await target.setImage(renderPromptKey(buildPromptViewModel(preset === undefined ? {} : { preset })));
	}
}
