/**
 * Git key — design §16.
 *
 * Follows the active project unless the key names a repository explicitly, so a
 * project switch moves every git key at once.
 */

import { action } from "@elgato/streamdeck";
import type { KeyAction, KeyDownEvent } from "@elgato/streamdeck";
import { renderGitKey } from "../presentation/renderers/key-renderer.js";
import { buildGitViewModel } from "../presentation/view-models/git.js";
import type { Unsubscribe } from "../domain/provider-events.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { RenderedKeyAction } from "./rendered-key-action.js";
import type { GitActionSettings } from "./settings.js";

@action({ UUID: "com.agentdeck.streamdeck-plus.git" })
export class GitAction extends RenderedKeyAction<GitActionSettings> {
	protected override get concerns(): readonly UiConcern[] {
		return ["git", "project"];
	}

	public override async onKeyDown(ev: KeyDownEvent<GitActionSettings>): Promise<void> {
		const path = this.#repositoryPath(ev.payload.settings);
		if (path === undefined) {
			await ev.action.showAlert();
			return;
		}
		const entry = await this.runtime.git.refresh(path);
		if (entry.status === undefined) {
			await ev.action.showAlert();
		}
	}

	/** Follows whichever repository the key is pointed at, and re-follows on change. */
	protected override watch(settings: GitActionSettings): readonly Unsubscribe[] {
		const path = this.#repositoryPath(settings);
		return path === undefined ? [] : [this.runtime.git.watch(path)];
	}

	/** Explicit setting wins; otherwise the active project is the repository. */
	#repositoryPath(settings: GitActionSettings): string | undefined {
		const configured = settings.repositoryPath?.trim();
		if (configured !== undefined && configured.length > 0) {
			return configured;
		}
		return this.runtime.projects.getActive()?.path;
	}

	protected override async render(
		target: KeyAction<GitActionSettings>,
		settings: GitActionSettings,
	): Promise<void> {
		const path = this.#repositoryPath(settings);
		const entry = path === undefined ? undefined : this.runtime.ui.getGitEntry(path);
		await target.setImage(renderGitKey(buildGitViewModel(entry)));
	}
}
