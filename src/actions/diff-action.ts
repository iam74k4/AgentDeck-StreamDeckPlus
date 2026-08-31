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

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { renderDiffKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { buildDiffViewModel } from "../presentation/view-models/diff.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { GitActionSettings } from "./settings.js";

const CONCERNS: readonly UiConcern[] = ["git", "project"];

@action({ UUID: "com.agentdeck.streamdeck-plus.diff" })
export class DiffAction extends SingletonAction<GitActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<GitActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<GitActionSettings>): void {
		this.#subscriptions.release(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<GitActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override async onKeyDown(ev: KeyDownEvent<GitActionSettings>): Promise<void> {
		const path = this.#repositoryPath(ev.payload.settings);
		if (path === undefined) {
			await ev.action.showAlert();
			return;
		}
		await this.#runtime.git.refresh(path);
		await ev.action.showOk();
	}

	#repositoryPath(settings: GitActionSettings): string | undefined {
		const configured = settings.repositoryPath;
		if (typeof configured === "string" && configured.length > 0) {
			return configured;
		}
		return this.#runtime.projects.getActive()?.path;
	}

	#bind(target: KeyAction<GitActionSettings>, settings: GitActionSettings): void {
		bindRenderer({
			subscriptions: this.#subscriptions,
			ui: this.#runtime.ui,
			target,
			settings,
			concerns: CONCERNS,
			render: (key, current) => this.#render(key, current),
			watch: (current) => {
				const path = this.#repositoryPath(current);
				return path === undefined ? [] : [this.#runtime.git.watch(path)];
			},
		});
	}

	async #render(target: KeyAction<GitActionSettings>, settings: GitActionSettings): Promise<void> {
		const path = this.#repositoryPath(settings);
		await target.setImage(
			renderDiffKey(buildDiffViewModel(path === undefined ? undefined : this.#runtime.ui.getGitEntry(path))),
		);
	}
}
