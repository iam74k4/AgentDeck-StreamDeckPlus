/**
 * The lifecycle every rendered key shares.
 *
 * Eleven key actions were repeating the same thirty lines: appear and settings
 * both rebind, disappear releases, and a redraw closure is rebuilt each time.
 * That divergence is where the stale-settings bug class came from — a key that
 * bound on `willAppear` and forgot to rebind on `didReceiveSettings` kept drawing
 * the original settings forever — so the shape lives in one place and a new key
 * cannot get it subtly wrong.
 *
 * A subclass says which concerns repaint it and how to draw itself. Everything
 * else is optional.
 */

import { SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import type { Unsubscribe } from "../domain/provider-events.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { SettingsValue } from "./settings.js";

export abstract class RenderedKeyAction<
	TSettings extends Record<string, SettingsValue>,
> extends SingletonAction<TSettings> {
	protected readonly runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.runtime = runtime;
	}

	/** UI concerns whose change repaints this key (design §20.2). */
	protected abstract get concerns(): readonly UiConcern[];

	/** Draws the key from the settings it is currently bound to. */
	protected abstract render(target: KeyAction<TSettings>, settings: TSettings): unknown;

	/**
	 * Extra per-settings resources — a watched repository, say.
	 *
	 * Released and re-acquired on every rebind, so a changed path is followed.
	 */
	protected watch(_settings: TSettings): readonly Unsubscribe[] {
		return [];
	}

	/** Runs before the subscriptions are released, for anything else in flight. */
	protected onReleased(_actionId: string): void {}

	public override onWillAppear(ev: WillAppearEvent<TSettings>): void {
		if (ev.action.isKey()) {
			this.bind(ev.action, ev.payload.settings);
		}
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<TSettings>): void {
		if (ev.action.isKey()) {
			this.bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<TSettings>): void {
		this.onReleased(ev.action.id);
		this.#subscriptions.release(ev.action.id);
	}

	protected bind(target: KeyAction<TSettings>, settings: TSettings): void {
		bindRenderer({
			subscriptions: this.#subscriptions,
			ui: this.runtime.ui,
			target,
			settings,
			concerns: this.concerns,
			render: (key, current) => this.render(key, current),
			watch: (current) => this.watch(current),
		});
	}
}
