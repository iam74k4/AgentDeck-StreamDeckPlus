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

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	KeyUpEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { renderVoiceKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { VoiceActionSettings } from "./settings.js";

const CONCERNS: readonly UiConcern[] = ["voice", "prompt"];

@action({ UUID: "com.agentdeck.streamdeck-plus.voice" })
export class VoiceAction extends SingletonAction<VoiceActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<VoiceActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<VoiceActionSettings>): void {
		// A key that disappears mid-recording must not leave the microphone open.
		void this.#runtime.voice.cancel();
		this.#subscriptions.release(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<VoiceActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override async onKeyDown(ev: KeyDownEvent<VoiceActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		try {
			await this.#runtime.voice.start();
		} catch (error) {
			this.#runtime.logger.warn("could not start recording", error);
			await ev.action.showAlert();
		}
	}

	public override async onKeyUp(ev: KeyUpEvent<VoiceActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		const settings = ev.payload.settings;
		const activePath = this.#runtime.projects.getActive()?.path;
		try {
			const result = await this.#runtime.voice.stopAndRun(settings.presetId, {
				providerId: settings.providerId ?? this.#runtime.defaultProviderId,
				...(activePath === undefined ? {} : { cwd: activePath }),
			});
			// Silence is not a failure, but it is not a success worth confirming.
			if (result === undefined) {
				await ev.action.showAlert();
				return;
			}
			await ev.action.showOk();
		} catch (error) {
			this.#runtime.logger.warn("could not send the transcript", error);
			await ev.action.showAlert();
		}
	}

	#bind(target: KeyAction<VoiceActionSettings>, settings: VoiceActionSettings): void {
		bindRenderer({
			subscriptions: this.#subscriptions,
			ui: this.#runtime.ui,
			target,
			settings,
			concerns: CONCERNS,
			render: (key) => this.#render(key),
		});
	}

	async #render(target: KeyAction<VoiceActionSettings>): Promise<void> {
		await target.setImage(renderVoiceKey(this.#runtime.ui.voiceViewModel()));
	}
}
