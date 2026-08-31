/**
 * Project key — design §7.1, instructions §4.
 *
 * Shows the active project and switches between registered ones. Switching is
 * what makes the git segment and every project-aware launcher follow along, so
 * this key is the one place the deck answers "which repository am I on".
 */

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { renderProjectKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { buildProjectViewModel } from "../presentation/view-models/project.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { ProjectActionSettings } from "./settings.js";

const CONCERNS: readonly UiConcern[] = ["project", "git"];

@action({ UUID: "com.agentdeck.streamdeck-plus.project" })
export class ProjectAction extends SingletonAction<ProjectActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<ProjectActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<ProjectActionSettings>): void {
		this.#subscriptions.release(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ProjectActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	/**
	 * A press activates: the pinned project when the key names one, the configured
	 * path when it has not been registered yet, otherwise the next project in the
	 * list.
	 */
	public override async onKeyDown(ev: KeyDownEvent<ProjectActionSettings>): Promise<void> {
		const settings = ev.payload.settings;
		try {
			const path = settings.addPath?.trim();
			if (path !== undefined && path.length > 0) {
				const project = await this.#runtime.projects.add({ path });
				await this.#runtime.projects.activate(project.id);
			} else if (settings.projectId !== undefined && settings.projectId.length > 0) {
				await this.#runtime.projects.activate(settings.projectId);
			} else if ((await this.#runtime.projects.cycle(1)) === undefined) {
				await ev.action.showAlert();
				return;
			}
			await ev.action.showOk();
		} catch (error) {
			this.#runtime.logger.warn("project activation failed", error);
			await ev.action.showAlert();
		}
	}

	#bind(target: KeyAction<ProjectActionSettings>, settings: ProjectActionSettings): void {
		bindRenderer({
			subscriptions: this.#subscriptions,
			ui: this.#runtime.ui,
			target,
			settings,
			concerns: CONCERNS,
			render: (key, current) => this.#render(key, current),
		});
	}

	async #render(target: KeyAction<ProjectActionSettings>, settings: ProjectActionSettings): Promise<void> {
		const projects = this.#runtime.projects;
		const pinned = settings.projectId === undefined ? undefined : projects.get(settings.projectId);
		const active = pinned ?? projects.getActive();

		const entry = active === undefined ? undefined : this.#runtime.ui.getGitEntry(active.path);
		const branch = entry?.status?.branch;

		await target.setImage(
			renderProjectKey(
				buildProjectViewModel({
					...(active === undefined ? {} : { active }),
					total: projects.list().length,
					...(branch === undefined ? {} : { gitSummary: branch }),
				}),
			),
		);
	}
}
