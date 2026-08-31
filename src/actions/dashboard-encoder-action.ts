/**
 * Touch-strip / encoder action — design §6.2, instructions §8.3.
 *
 * One instance owns one 200x100 segment. Registration is keyed on
 * `Map<DeviceId, Map<Column, EncoderContext>>` via `willAppear` / `willDisappear`;
 * when all four columns belong to AgentDeck the coordinator drives them as one
 * dashboard, otherwise each falls back to Standalone Segment Mode.
 *
 * Dial behaviour follows design §6.1: rotate switches the view and press
 * refreshes, except on the segments that have a meaning of their own — usage
 * rotates through windows, and model rotates through models and efforts with the
 * press applying the highlighted one (design §19).
 */

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DialDownEvent,
	DialRotateEvent,
	DidReceiveSettingsEvent,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import type { UsageWindow, WindowSelection } from "../domain/usage.js";
import { selectWindow } from "../domain/usage.js";
import type { Column, SegmentKind } from "../presentation/plus-dashboard-coordinator.js";
import { isColumn, SEGMENT_KINDS } from "../presentation/plus-dashboard-coordinator.js";
import { SEGMENT_LAYOUT_ID, type SegmentFeedback } from "../presentation/renderers/encoder-renderer.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import type { DashboardEncoderSettings } from "./settings.js";

/** Minimal shape this action needs from a dial, so it can be exercised in tests. */
interface DialTarget {
	readonly id: string;
	readonly device: { readonly id: string };
	setFeedback(feedback: SegmentFeedback): Promise<void> | void;
	setFeedbackLayout(layout: string): Promise<void> | void;
	setSettings(settings: DashboardEncoderSettings): Promise<void> | void;
}

@action({ UUID: "com.agentdeck.streamdeck-plus.dashboard" })
export class DashboardEncoderAction extends SingletonAction<DashboardEncoderSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();
	/** Column per action instance, so a rotate can re-register without a fresh event. */
	readonly #columns = new Map<string, Column>();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override async onWillAppear(ev: WillAppearEvent<DashboardEncoderSettings>): Promise<void> {
		if (!ev.action.isDial()) {
			return;
		}
		const column = encoderColumn(ev.payload);
		if (!isColumn(column)) {
			this.#runtime.logger.warn(`unexpected encoder column ${column}`);
			return;
		}
		await ev.action.setFeedbackLayout(SEGMENT_LAYOUT_ID);
		this.#bind(ev.action, column, ev.payload.settings);
	}

	public override onWillDisappear(ev: WillDisappearEvent<DashboardEncoderSettings>): void {
		this.#runtime.dashboard.unregister(ev.action.device.id, ev.action.id);
		this.#subscriptions.release(ev.action.id);
		this.#columns.delete(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<DashboardEncoderSettings>): void {
		if (!ev.action.isDial()) {
			return;
		}
		const column = this.#columns.get(ev.action.id) ?? encoderColumn(ev.payload);
		if (isColumn(column)) {
			this.#bind(ev.action, column, ev.payload.settings);
		}
	}

	/**
	 * Press → apply on a model segment (design §19 "Press → Apply"), otherwise a
	 * manual refresh of everything this segment can show (design §6.1).
	 */
	public override async onDialDown(ev: DialDownEvent<DashboardEncoderSettings>): Promise<void> {
		const segment = ev.action.isDial() ? this.#segmentOf(ev.action, ev.payload) : undefined;
		if (segment === "model") {
			await this.#applyModel(ev.payload.settings);
			return;
		}
		if (segment === "prompt") {
			await this.#runPrompt(ev.payload.settings);
			return;
		}
		await this.#refreshAll(ev.payload.settings);
	}

	public override async onTouchTap(ev: TouchTapEvent<DashboardEncoderSettings>): Promise<void> {
		await this.#refreshAll(ev.payload.settings);
	}

	/**
	 * Rotate → cycle the view (design §6.1).
	 *
	 * On a usage segment that steps through `auto` and each of the provider's
	 * windows, pinning the chosen one. Elsewhere it steps through the segment
	 * kinds, which only has an effect in Standalone Segment Mode.
	 *
	 * The new settings are applied locally as well as persisted: plugin-side
	 * `setSettings` does not echo back as `didReceiveSettings`, so waiting for
	 * that event would leave the dial saved-but-unchanged until a profile switch.
	 */
	public override async onDialRotate(ev: DialRotateEvent<DashboardEncoderSettings>): Promise<void> {
		if (!ev.action.isDial()) {
			return;
		}
		const settings = ev.payload.settings;
		const column = this.#columns.get(ev.action.id) ?? encoderColumn(ev.payload);
		if (!isColumn(column)) {
			return;
		}

		const direction = ev.payload.ticks >= 0 ? 1 : -1;
		const segment = this.#runtime.dashboard.segmentFor(ev.action.device.id, column);

		// Design §19: rotating a model segment moves the highlight and nothing
		// else. It is not persisted as a setting, because it is a choice about the
		// session rather than about this key.
		if (segment === "model") {
			this.#runtime.models.rotate(settings.providerId ?? this.#runtime.defaultProviderId, direction);
			return;
		}

		// Design §14 — the dial is how a preset is chosen, so rotation selects and
		// only the press sends.
		if (segment === "prompt") {
			this.#runtime.prompts.rotate(direction);
			return;
		}

		const next =
			segment === "usage"
				? this.#cycleUsageWindow(settings, direction)
				: { ...settings, segment: cycleSegment(settings.segment ?? segment, direction) };

		await ev.action.setSettings(next);
		this.#bind(ev.action, column, next);
	}

	/**
	 * Steps through `auto` followed by every reported window.
	 *
	 * `auto` stays in the cycle on purpose: design §7.5 says a pinned window that
	 * disappears shows `--` and is never substituted, so the user needs a way back.
	 */
	#cycleUsageWindow(settings: DashboardEncoderSettings, direction: number): DashboardEncoderSettings {
		const providerId = settings.providerId ?? this.#runtime.defaultProviderId;
		const windows = this.#runtime.ui.getUsageSnapshot(providerId)?.windows ?? [];
		if (windows.length === 0) {
			return settings;
		}

		const options: (UsageWindow | undefined)[] = [undefined, ...windows];
		const currentIndex = currentWindowIndex(options, settings, windows);
		const chosen = options[(currentIndex + direction + options.length) % options.length];

		if (chosen === undefined) {
			const { windowId: _windowId, ...rest } = settings;
			return { ...rest, windowMode: "auto" };
		}
		return { ...settings, windowMode: "pinned", windowId: chosen.id };
	}

	#bind(target: DialTarget, column: Column, settings: DashboardEncoderSettings): void {
		this.#columns.set(target.id, column);
		this.#subscriptions.release(target.id);

		this.#runtime.dashboard.register(target.device.id, column, {
			id: target.id,
			...(settings.segment === undefined ? {} : { preferredSegment: settings.segment }),
			setFeedback: (feedback) => target.setFeedback(feedback),
		});

		const path = settings.repositoryPath;
		if (path !== undefined && path.length > 0) {
			this.#subscriptions.add(target.id, this.#runtime.git.watch(path));
		}

		// The model list is only fetched when a segment actually shows it; the
		// service shares one in-flight request across encoders (design §17.2).
		if (this.#runtime.dashboard.segmentFor(target.device.id, column) === "model") {
			void this.#runtime.models.refresh(settings.providerId ?? this.#runtime.defaultProviderId);
		}

		this.#publishContext(settings);
	}

	/** The segment a dial event belongs to, resolved the same way a redraw does. */
	#segmentOf(
		target: DialTarget,
		payload: { coordinates?: { column: number } } | object,
	): SegmentKind | undefined {
		const column = this.#columns.get(target.id) ?? encoderColumn(payload);
		return isColumn(column) ? this.#runtime.dashboard.segmentFor(target.device.id, column) : undefined;
	}

	async #applyModel(settings: DashboardEncoderSettings): Promise<void> {
		const providerId = settings.providerId ?? this.#runtime.defaultProviderId;
		try {
			await this.#runtime.models.apply(providerId);
		} catch (error) {
			this.#runtime.logger.warn("could not apply the selected model", error);
		}
	}

	async #runPrompt(settings: DashboardEncoderSettings): Promise<void> {
		const activePath = this.#runtime.projects.getActive()?.path;
		try {
			await this.#runtime.prompts.run(undefined, {
				providerId: settings.providerId ?? this.#runtime.defaultProviderId,
				...(activePath === undefined ? {} : { cwd: activePath }),
			});
		} catch (error) {
			this.#runtime.logger.warn("prompt failed", error);
		}
	}

	async #refreshAll(settings: DashboardEncoderSettings): Promise<void> {
		const providerId = settings.providerId ?? this.#runtime.defaultProviderId;
		await this.#runtime.usage.refresh(providerId, { manual: true });
		const path = settings.repositoryPath;
		if (path !== undefined && path.length > 0) {
			await this.#runtime.git.refresh(path);
		}
		this.#publishContext(settings);
	}

	/**
	 * Publishes this segment's provider, repository and window choice to the
	 * runtime, so background redraws keep pointing at the same context, then
	 * repaints the strip.
	 */
	#publishContext(settings: DashboardEncoderSettings): void {
		this.#runtime.setDashboardContext({
			providerId: settings.providerId ?? this.#runtime.defaultProviderId,
			...(settings.repositoryPath === undefined ? {} : { repositoryPath: settings.repositoryPath }),
			windowSelection: windowSelectionOf(settings),
		});
	}
}

export function windowSelectionOf(settings: DashboardEncoderSettings): WindowSelection {
	if (
		settings.windowMode === "pinned" &&
		typeof settings.windowId === "string" &&
		settings.windowId.length > 0
	) {
		return { mode: "pinned", windowId: settings.windowId };
	}
	return { mode: "auto" };
}

function currentWindowIndex(
	options: readonly (UsageWindow | undefined)[],
	settings: DashboardEncoderSettings,
	windows: readonly UsageWindow[],
): number {
	const selection = windowSelectionOf(settings);
	if (selection.mode === "auto") {
		return 0;
	}
	const current = selectWindow(windows, selection);
	const index = options.findIndex((option) => option !== undefined && option.id === current?.id);
	// A pinned window that has disappeared resumes the cycle from `auto`.
	return index === -1 ? 0 : index;
}

export function cycleSegment(current: SegmentKind, direction: number): SegmentKind {
	const index = SEGMENT_KINDS.indexOf(current);
	const next = (index + direction + SEGMENT_KINDS.length) % SEGMENT_KINDS.length;
	return SEGMENT_KINDS[next] ?? current;
}

/** Dial payloads always carry coordinates; multi-action payloads never do. */
function encoderColumn(payload: { coordinates?: { column: number } } | object): number {
	const coordinates = (payload as { coordinates?: { column?: number } }).coordinates;
	return typeof coordinates?.column === "number" ? coordinates.column : -1;
}
