/**
 * Binds one action instance to the UI concerns it draws.
 *
 * Both `willAppear` and `didReceiveSettings` go through here, so a settings
 * change always rebuilds the redraw closure. That is the point: the Stream Deck
 * SDK hands out a *fresh* payload object per event (`ActionEvent` assigns
 * `this.payload = source.payload`), so a closure that captured
 * `ev.payload.settings` at `willAppear` keeps drawing the original settings
 * forever, and a background repaint silently reverts what the user just changed.
 *
 * Every renderable action shares this one path rather than repeating it, because
 * the version of this bug that shipped came from exactly that divergence.
 */

import type { Unsubscribe } from "../domain/provider-events.js";
import type { UiConcern, UiCoordinator } from "../presentation/ui-coordinator.js";
import type { ActionSubscriptions } from "./action-subscriptions.js";

export interface RendererBinding<TTarget extends { id: string }, TSettings> {
	subscriptions: ActionSubscriptions;
	ui: UiCoordinator;
	target: TTarget;
	settings: TSettings;
	/** UI concerns whose change should repaint this action. */
	concerns: readonly UiConcern[];
	render: (target: TTarget, settings: TSettings) => unknown;
	/** Extra per-settings resources, e.g. a watched repository path. */
	watch?: (settings: TSettings) => readonly Unsubscribe[];
}

export function bindRenderer<TTarget extends { id: string }, TSettings>(
	binding: RendererBinding<TTarget, TSettings>,
): void {
	const { subscriptions, ui, target, settings, concerns, render, watch } = binding;

	// Releasing first makes this safe to call again for the same action instance.
	subscriptions.release(target.id);

	const redraw = (): void => void render(target, settings);
	subscriptions.add(target.id, ...concerns.map((concern) => ui.subscribe(concern, redraw)));
	if (watch !== undefined) {
		subscriptions.add(target.id, ...watch(settings));
	}

	redraw();
}
