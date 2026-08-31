/**
 * Git key — design §16.
 *
 * Follows the active project unless the key names a repository explicitly, so a
 * project switch moves every git key at once.
 */

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { renderGitKey } from "../presentation/renderers/key-renderer.js";
import { buildGitViewModel } from "../presentation/view-models/git.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { GitActionSettings } from "./settings.js";

const CONCERNS: readonly UiConcern[] = ["git", "project"];

@action({ UUID: "com.agentdeck.streamdeck-plus.git" })
export class GitAction extends SingletonAction<GitActionSettings> {
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
		const entry = await this.#runtime.git.refresh(path);
		if (entry.status === undefined) {
			await ev.action.showAlert();
		}
	}

	/** Explicit setting wins; otherwise the active project is the repository. */
	#repositoryPath(settings: GitActionSettings): string | undefined {
		const configured = settings.repositoryPath?.trim();
		if (configured !== undefined && configured.length > 0) {
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
		const entry = path === undefined ? undefined : this.#runtime.ui.getGitEntry(path);
		await target.setImage(renderGitKey(buildGitViewModel(entry)));
	}
}
