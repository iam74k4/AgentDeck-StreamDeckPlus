/**
 * Stream Deck Plus touch-strip coordinator — design §6.2, instructions §8.3.
 *
 * Each encoder owns one 200x100 region. When all four regions on a device belong
 * to AgentDeck they are driven as a single dashboard, with the column deciding the
 * segment. Otherwise each encoder falls back to Standalone Segment Mode and renders
 * whatever its own action settings ask for.
 *
 *   Map<DeviceId, Map<Column, EncoderContext>>
 *
 * Registration follows `willAppear` / `willDisappear`, so a profile switch is a
 * normal, expected transition rather than a special case.
 */

import type { SegmentFeedback } from "./renderers/encoder-renderer.js";
import {
	renderAgentSegment,
	renderGitSegment,
	renderProviderSegment,
	renderUsageSegment,
} from "./renderers/encoder-renderer.js";
import type { AgentStatusViewModel } from "./view-models/agent-status.js";
import type { GitViewModel } from "./view-models/git.js";
import type { ProviderViewModel } from "./view-models/provider.js";
import type { UsageViewModel } from "./view-models/usage.js";

export type DeviceId = string;
export type Column = 0 | 1 | 2 | 3;
export const SEGMENT_KINDS = ["usage", "agent", "git", "provider"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export type DashboardMode = "dashboard" | "standalone";

export const DASHBOARD_COLUMNS: Readonly<Record<Column, SegmentKind>> = {
	0: "usage",
	1: "agent",
	2: "git",
	3: "provider",
};

export const ENCODER_COLUMN_COUNT = 4;

export interface EncoderContext {
	/** Stream Deck action instance id. */
	readonly id: string;
	/** Segment this encoder renders when the dashboard is not fully occupied. */
	preferredSegment?: SegmentKind;
	setFeedback(feedback: SegmentFeedback): Promise<void> | void;
}

export interface DashboardData {
	usage: UsageViewModel;
	agent: AgentStatusViewModel;
	git: GitViewModel;
	provider: ProviderViewModel;
}

export function isColumn(value: number): value is Column {
	return value === 0 || value === 1 || value === 2 || value === 3;
}

export class PlusDashboardCoordinator {
	readonly #devices = new Map<DeviceId, Map<Column, EncoderContext>>();
	readonly #onError: ((error: unknown) => void) | undefined;
	#data: DashboardData | undefined;

	public constructor(options: { onError?: (error: unknown) => void } = {}) {
		this.#onError = options.onError;
	}

	/** `willAppear` — claims a column on a device. */
	public register(deviceId: DeviceId, column: Column, context: EncoderContext): void {
		let columns = this.#devices.get(deviceId);
		if (columns === undefined) {
			columns = new Map();
			this.#devices.set(deviceId, columns);
		}
		columns.set(column, context);
		if (this.#data !== undefined) {
			this.#renderDevice(deviceId, columns, this.#data);
		}
	}

	/** `willDisappear` — releases whichever column that action instance held. */
	public unregister(deviceId: DeviceId, actionId: string): void {
		const columns = this.#devices.get(deviceId);
		if (columns === undefined) {
			return;
		}
		for (const [column, context] of columns) {
			if (context.id === actionId) {
				columns.delete(column);
			}
		}
		if (columns.size === 0) {
			this.#devices.delete(deviceId);
		}
	}

	public mode(deviceId: DeviceId): DashboardMode {
		return this.#devices.get(deviceId)?.size === ENCODER_COLUMN_COUNT ? "dashboard" : "standalone";
	}

	public columnCount(deviceId: DeviceId): number {
		return this.#devices.get(deviceId)?.size ?? 0;
	}

	public get deviceIds(): DeviceId[] {
		return [...this.#devices.keys()];
	}

	/** Resolves the segment an encoder should draw, honouring the current mode. */
	public segmentFor(deviceId: DeviceId, column: Column): SegmentKind {
		if (this.mode(deviceId) === "dashboard") {
			return DASHBOARD_COLUMNS[column];
		}
		const preferred = this.#devices.get(deviceId)?.get(column)?.preferredSegment;
		return preferred ?? DASHBOARD_COLUMNS[column];
	}

	/** Redraws every registered encoder from the latest view models. */
	public update(data: DashboardData): void {
		this.#data = data;
		for (const [deviceId, columns] of this.#devices) {
			this.#renderDevice(deviceId, columns, data);
		}
	}

	/**
	 * All segments of a device are dispatched in the same tick so the strip updates
	 * as one frame; a failure on one encoder never stops the others.
	 */
	#renderDevice(deviceId: DeviceId, columns: Map<Column, EncoderContext>, data: DashboardData): void {
		for (const [column, context] of columns) {
			try {
				const result = context.setFeedback(renderSegment(this.segmentFor(deviceId, column), data));
				if (result instanceof Promise) {
					result.catch((error: unknown) => this.#onError?.(error));
				}
			} catch (error) {
				this.#onError?.(error);
			}
		}
	}
}

export function renderSegment(kind: SegmentKind, data: DashboardData): SegmentFeedback {
	switch (kind) {
		case "usage":
			return renderUsageSegment(data.usage);
		case "agent":
			return renderAgentSegment(data.agent);
		case "git":
			return renderGitSegment(data.git);
		case "provider":
			return renderProviderSegment(data.provider);
	}
}
