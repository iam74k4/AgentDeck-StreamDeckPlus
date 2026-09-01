/**
 * App Launcher key — design §11, instructions §4.
 *
 * An Environment Utility: it starts the tools the user already has, in the
 * active project's directory when that makes sense.
 */

import { action } from "@elgato/streamdeck";
import type { KeyAction, KeyDownEvent } from "@elgato/streamdeck";
import { renderLauncherKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { RenderedKeyAction } from "./rendered-key-action.js";
import type { LauncherActionSettings } from "./settings.js";

@action({ UUID: "com.agentdeck.streamdeck-plus.launcher" })
export class LauncherAction extends RenderedKeyAction<LauncherActionSettings> {
	protected override get concerns(): readonly UiConcern[] {
		return ["project"];
	}

	public override async onKeyDown(ev: KeyDownEvent<LauncherActionSettings>): Promise<void> {
		const launcher = this.#resolve(ev.payload.settings);
		if (launcher === undefined) {
			await ev.action.showAlert();
			return;
		}

		try {
			const projectPath =
				ev.payload.settings.useActiveProject === false ? undefined : this.runtime.projects.getActive()?.path;
			await launcher.launch(projectPath === undefined ? {} : { projectPath });
			await ev.action.showOk();
		} catch (error) {
			this.runtime.logger.warn(`failed to launch ${launcher.displayName}`, error);
			await ev.action.showAlert();
		}
	}

	#resolve(settings: LauncherActionSettings) {
		return this.runtime.launchers.resolve({
			...(settings.appId === undefined ? {} : { appId: settings.appId }),
			...(settings.command === undefined ? {} : { command: settings.command }),
		});
	}

	protected override async render(
		target: KeyAction<LauncherActionSettings>,
		settings: LauncherActionSettings,
	): Promise<void> {
		const launcher = this.#resolve(settings);
		const installed = launcher === undefined ? false : await launcher.isInstalled();
		const project = settings.useActiveProject === false ? undefined : this.runtime.projects.getActive()?.name;

		await target.setImage(
			renderLauncherKey({
				name: launcher?.displayName ?? "LAUNCH",
				detail: installed ? (project ?? "") : "not found",
				installed,
			}),
		);
	}
}
