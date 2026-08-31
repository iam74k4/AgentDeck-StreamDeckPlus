/**
 * App Launcher key — design §11, instructions §4.
 *
 * An Environment Utility: it starts the tools the user already has, in the
 * active project's directory when that makes sense.
 */

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { renderLauncherKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { LauncherActionSettings } from "./settings.js";

const CONCERNS: readonly UiConcern[] = ["project"];

@action({ UUID: "com.agentdeck.streamdeck-plus.launcher" })
export class LauncherAction extends SingletonAction<LauncherActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<LauncherActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<LauncherActionSettings>): void {
		this.#subscriptions.release(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<LauncherActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override async onKeyDown(ev: KeyDownEvent<LauncherActionSettings>): Promise<void> {
		const launcher = this.#resolve(ev.payload.settings);
		if (launcher === undefined) {
			await ev.action.showAlert();
			return;
		}

		try {
			const projectPath =
				ev.payload.settings.useActiveProject === false ? undefined : this.#runtime.projects.getActive()?.path;
			await launcher.launch(projectPath === undefined ? {} : { projectPath });
			await ev.action.showOk();
		} catch (error) {
			this.#runtime.logger.warn(`failed to launch ${launcher.displayName}`, error);
			await ev.action.showAlert();
		}
	}

	#resolve(settings: LauncherActionSettings) {
		return this.#runtime.launchers.resolve({
			...(settings.appId === undefined ? {} : { appId: settings.appId }),
			...(settings.command === undefined ? {} : { command: settings.command }),
		});
	}

	#bind(target: KeyAction<LauncherActionSettings>, settings: LauncherActionSettings): void {
		bindRenderer({
			subscriptions: this.#subscriptions,
			ui: this.#runtime.ui,
			target,
			settings,
			concerns: CONCERNS,
			render: (key, current) => this.#render(key, current),
		});
	}

	async #render(target: KeyAction<LauncherActionSettings>, settings: LauncherActionSettings): Promise<void> {
		const launcher = this.#resolve(settings);
		const installed = launcher === undefined ? false : await launcher.isInstalled();
		const project =
			settings.useActiveProject === false ? undefined : this.#runtime.projects.getActive()?.name;

		await target.setImage(
			renderLauncherKey({
				name: launcher?.displayName ?? "LAUNCH",
				detail: installed ? (project ?? "") : "not found",
				installed,
			}),
		);
	}
}
