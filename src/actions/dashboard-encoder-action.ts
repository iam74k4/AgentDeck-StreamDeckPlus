/**
 * Touch-strip / encoder action — design §6.2, instructions §8.3.
 *
 * One instance owns one 200x100 segment. Registration is keyed on
 * `Map<DeviceId, Map<Column, EncoderContext>>` via `willAppear` / `willDisappear`;
 * when all four columns belong to AgentDeck the coordinator drives them as one
 * dashboard, otherwise each falls back to Standalone Segment Mode.
 *
 * Dial 1 behaviour follows design §6.1: rotate switches the view, press refreshes.
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
import { selectWindow } from "../domain/usage.js";
import { isColumn, type SegmentKind, SEGMENT_KINDS } from "../presentation/plus-dashboard-coordinator.js";
import { SEGMENT_LAYOUT_ID } from "../presentation/renderers/encoder-renderer.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import type { DashboardEncoderSettings } from "./settings.js";

@action({ UUID: "com.agentdeck.streamdeck-plus.dashboard" })
export class DashboardEncoderAction extends SingletonAction<DashboardEncoderSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();

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

		const target = ev.action;
		await target.setFeedbackLayout(SEGMENT_LAYOUT_ID);

		this.#runtime.dashboard.register(ev.action.device.id, column, {
			id: ev.action.id,
			...(ev.payload.settings.segment === undefined ? {} : { preferredSegment: ev.payload.settings.segment }),
			setFeedback: (feedback) => target.setFeedback(feedback),
		});

		const path = ev.payload.settings.repositoryPath;
		if (path !== undefined && path.length > 0) {
			this.#subscriptions.add(ev.action.id, this.#runtime.git.watch(path));
		}

		this.#refreshDashboard(ev.payload.settings);
	}

	public override onWillDisappear(ev: WillDisappearEvent<DashboardEncoderSettings>): void {
		this.#runtime.dashboard.unregister(ev.action.device.id, ev.action.id);
		this.#subscriptions.release(ev.action.id);
	}

	public override async onDidReceiveSettings(
		ev: DidReceiveSettingsEvent<DashboardEncoderSettings>,
	): Promise<void> {
		if (!ev.action.isDial()) {
			return;
		}
		// Re-register so the coordinator picks up a changed segment or watched path.
		this.#runtime.dashboard.unregister(ev.action.device.id, ev.action.id);
		this.#subscriptions.release(ev.action.id);
		await this.onWillAppear(ev as unknown as WillAppearEvent<DashboardEncoderSettings>);
	}

	/** Press → manual refresh of everything this segment can show (design §6.1). */
	public override async onDialDown(ev: DialDownEvent<DashboardEncoderSettings>): Promise<void> {
		await this.#refreshAll(ev.payload.settings);
	}

	public override async onTouchTap(ev: TouchTapEvent<DashboardEncoderSettings>): Promise<void> {
		await this.#refreshAll(ev.payload.settings);
	}

	/**
	 * Rotate → cycle the view.
	 *
	 * On a usage segment that means stepping through the provider's windows and
	 * pinning the chosen one; elsewhere it steps through the segment kinds, which
	 * is only reachable in Standalone Segment Mode.
	 */
	public override async onDialRotate(ev: DialRotateEvent<DashboardEncoderSettings>): Promise<void> {
		if (!ev.action.isDial()) {
			return;
		}
		const settings = ev.payload.settings;
		const direction = ev.payload.ticks >= 0 ? 1 : -1;
		const deviceId = ev.action.device.id;
		const column = encoderColumn(ev.payload);
		const segment = isColumn(column)
			? this.#runtime.dashboard.segmentFor(deviceId, column)
			: (settings.segment ?? "usage");

		const next: DashboardEncoderSettings =
			segment === "usage"
				? this.#cycleUsageWindow(settings, direction)
				: { ...settings, segment: cycleSegment(settings.segment ?? segment, direction) };

		await ev.action.setSettings(next);
		this.#refreshDashboard(next);
	}

	#cycleUsageWindow(settings: DashboardEncoderSettings, direction: number): DashboardEncoderSettings {
		const providerId = settings.providerId ?? this.#runtime.defaultProviderId;
		const windows = this.#runtime.ui.getUsageSnapshot(providerId)?.windows ?? [];
		if (windows.length === 0) {
			return settings;
		}

		const current = selectWindow(windows, { mode: "auto" });
		const currentIndex = windows.findIndex((window) => window.id === current?.id);
		const nextIndex = (currentIndex + direction + windows.length) % windows.length;
		const next = windows[nextIndex];
		return next === undefined ? settings : { ...settings, segment: "usage" };
	}

	async #refreshAll(settings: DashboardEncoderSettings): Promise<void> {
		const providerId = settings.providerId ?? this.#runtime.defaultProviderId;
		await this.#runtime.usage.refresh(providerId, { manual: true });
		const path = settings.repositoryPath;
		if (path !== undefined && path.length > 0) {
			await this.#runtime.git.refresh(path);
		}
		this.#refreshDashboard(settings);
	}

	/**
	 * Publishes this segment's provider/repository to the runtime so background
	 * redraws keep pointing at the same context, then repaints the strip.
	 */
	#refreshDashboard(settings: DashboardEncoderSettings): void {
		this.#runtime.setDashboardContext({
			providerId: settings.providerId ?? this.#runtime.defaultProviderId,
			...(settings.repositoryPath === undefined ? {} : { repositoryPath: settings.repositoryPath }),
		});
	}
}

/** Dial payloads always carry coordinates; multi-action payloads never do. */
function encoderColumn(payload: { coordinates?: { column: number } } | object): number {
	const coordinates = (payload as { coordinates?: { column?: number } }).coordinates;
	return typeof coordinates?.column === "number" ? coordinates.column : -1;
}

export function cycleSegment(current: SegmentKind, direction: number): SegmentKind {
	const index = SEGMENT_KINDS.indexOf(current);
	const next = (index + direction + SEGMENT_KINDS.length) % SEGMENT_KINDS.length;
	return SEGMENT_KINDS[next] ?? current;
}
