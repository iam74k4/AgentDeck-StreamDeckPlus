/**
 * Git key — design §16.
 *
 * The repository path comes from action settings during the spike. Once the
 * project service lands in v0.1 it becomes the active project's path.
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

const CONCERNS: readonly UiConcern[] = ["git"];

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
		const path = ev.payload.settings.repositoryPath;
		if (path === undefined || path.length === 0) {
			await ev.action.showAlert();
			return;
		}
		const entry = await this.#runtime.git.refresh(path);
		if (entry.status === undefined) {
			await ev.action.showAlert();
		}
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
				const path = current.repositoryPath;
				return path === undefined || path.length === 0 ? [] : [this.#runtime.git.watch(path)];
			},
		});
	}

	async #render(target: KeyAction<GitActionSettings>, settings: GitActionSettings): Promise<void> {
		const path = settings.repositoryPath;
		const entry = path === undefined || path.length === 0 ? undefined : this.#runtime.ui.getGitEntry(path);
		await target.setImage(renderGitKey(buildGitViewModel(entry)));
	}
}
