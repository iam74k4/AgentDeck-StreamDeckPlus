/**
 * Diff key — design §16.2.
 *
 * Shows how large the working-tree change is: additions, removals, files. Not
 * what changed — reading a diff belongs in the editor (design §3.5), and a key
 * that tried would be unreadable.
 *
 * It follows the same repository the Git key does: the one named in settings, or
 * the active project.
 */

import { action } from "@elgato/streamdeck";
import type { KeyAction, KeyDownEvent } from "@elgato/streamdeck";
import { renderDiffKey } from "../presentation/renderers/key-renderer.js";
import type { Unsubscribe } from "../domain/provider-events.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { buildDiffViewModel } from "../presentation/view-models/diff.js";
import { RenderedKeyAction } from "./rendered-key-action.js";
import type { GitActionSettings } from "./settings.js";

@action({ UUID: "com.agentdeck.streamdeck-plus.diff" })
export class DiffAction extends RenderedKeyAction<GitActionSettings> {
	protected override get concerns(): readonly UiConcern[] {
		return ["git", "project"];
	}

	public override async onKeyDown(ev: KeyDownEvent<GitActionSettings>): Promise<void> {
		const path = this.#repositoryPath(ev.payload.settings);
		if (path === undefined) {
			await ev.action.showAlert();
			return;
		}
		await this.runtime.git.refresh(path);
		await ev.action.showOk();
	}

	/** Follows whichever repository the key is pointed at, and re-follows on change. */
	protected override watch(settings: GitActionSettings): readonly Unsubscribe[] {
		const path = this.#repositoryPath(settings);
		return path === undefined ? [] : [this.runtime.git.watch(path)];
	}

	#repositoryPath(settings: GitActionSettings): string | undefined {
		const configured = settings.repositoryPath;
		if (typeof configured === "string" && configured.length > 0) {
			return configured;
		}
		return this.runtime.projects.getActive()?.path;
	}

	protected override async render(
		target: KeyAction<GitActionSettings>,
		settings: GitActionSettings,
	): Promise<void> {
		const path = this.#repositoryPath(settings);
		await target.setImage(
			renderDiffKey(buildDiffViewModel(path === undefined ? undefined : this.runtime.ui.getGitEntry(path))),
		);
	}
}
