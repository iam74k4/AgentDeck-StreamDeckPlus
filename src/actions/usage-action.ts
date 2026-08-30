/**
 * Usage key — design §17, §23.2.
 *
 * Reads from the shared usage cache; several usage keys cost one provider call
 * (design §17.1). A press is a manual refresh, allowed during backoff but
 * throttled (design §21.3).
 */

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import type { WindowSelection } from "../domain/usage.js";
import { renderUsageKey } from "../presentation/renderers/key-renderer.js";
import { buildUsageViewModel } from "../presentation/view-models/usage.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { UsageActionSettings } from "./settings.js";

const CONCERNS: readonly UiConcern[] = ["usage", "provider"];

@action({ UUID: "com.agentdeck.streamdeck-plus.usage" })
export class UsageAction extends SingletonAction<UsageActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<UsageActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<UsageActionSettings>): void {
		this.#subscriptions.release(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<UsageActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	#bind(target: KeyAction<UsageActionSettings>, settings: UsageActionSettings): void {
		bindRenderer({
			subscriptions: this.#subscriptions,
			ui: this.#runtime.ui,
			target,
			settings,
			concerns: CONCERNS,
			render: (key, current) => this.#render(key, current),
		});
	}

	public override async onKeyDown(ev: KeyDownEvent<UsageActionSettings>): Promise<void> {
		const providerId = ev.payload.settings.providerId ?? this.#runtime.defaultProviderId;
		const snapshot = await this.#runtime.usage.refresh(providerId, { manual: true });
		if (snapshot.status === "error" || snapshot.status === "cli-not-found") {
			await ev.action.showAlert();
		}
	}

	async #render(target: KeyAction<UsageActionSettings>, settings: UsageActionSettings): Promise<void> {
		const providerId = settings.providerId ?? this.#runtime.defaultProviderId;
		const provider = this.#runtime.registry.get(providerId);

		const viewModel = buildUsageViewModel({
			providerLabel: provider?.displayName ?? providerId,
			snapshot: this.#runtime.ui.getUsageSnapshot(providerId),
			selection: windowSelection(settings),
			...(settings.displayMode === undefined ? {} : { displayMode: settings.displayMode }),
			...(settings.warnAtPercent === undefined ? {} : { warnAtPercent: settings.warnAtPercent }),
			...(settings.dangerAtPercent === undefined ? {} : { dangerAtPercent: settings.dangerAtPercent }),
			showResetAt: settings.showResetAt === true,
		});

		await target.setImage(renderUsageKey(viewModel));
	}
}

/** Design §7.5 — a pinned window is never silently replaced. */
export function windowSelection(settings: UsageActionSettings): WindowSelection {
	if (
		settings.windowMode === "pinned" &&
		typeof settings.windowId === "string" &&
		settings.windowId.length > 0
	) {
		return { mode: "pinned", windowId: settings.windowId };
	}
	return { mode: "auto" };
}
