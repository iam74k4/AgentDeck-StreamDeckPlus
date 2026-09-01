/**
 * Usage key — design §17, §23.2.
 *
 * Reads from the shared usage cache; several usage keys cost one provider call
 * (design §17.1). A press is a manual refresh, allowed during backoff but
 * throttled (design §21.3).
 */

import { action } from "@elgato/streamdeck";
import type { KeyAction, KeyDownEvent } from "@elgato/streamdeck";
import type { WindowSelection } from "../domain/usage.js";
import { renderUsageKey } from "../presentation/renderers/key-renderer.js";
import { buildUsageViewModel } from "../presentation/view-models/usage.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { RenderedKeyAction } from "./rendered-key-action.js";
import type { UsageActionSettings } from "./settings.js";

@action({ UUID: "com.agentdeck.streamdeck-plus.usage" })
export class UsageAction extends RenderedKeyAction<UsageActionSettings> {
	protected override get concerns(): readonly UiConcern[] {
		return ["usage", "provider"];
	}

	public override async onKeyDown(ev: KeyDownEvent<UsageActionSettings>): Promise<void> {
		const providerId = ev.payload.settings.providerId ?? this.runtime.defaultProviderId;
		const snapshot = await this.runtime.usage.refresh(providerId, { manual: true });
		if (snapshot.status === "error" || snapshot.status === "cli-not-found") {
			await ev.action.showAlert();
		}
	}

	protected override async render(
		target: KeyAction<UsageActionSettings>,
		settings: UsageActionSettings,
	): Promise<void> {
		const providerId = settings.providerId ?? this.runtime.defaultProviderId;
		const provider = this.runtime.registry.get(providerId);

		const viewModel = buildUsageViewModel({
			providerLabel: provider?.displayName ?? providerId,
			snapshot: this.runtime.ui.getUsageSnapshot(providerId),
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
