/**
 * Action settings — design §23.2.
 *
 * Refresh intervals and executable overrides are provider/global settings, not
 * per-action settings (design §17.4), so they deliberately do not appear here.
 */

import type { SegmentKind } from "../presentation/plus-dashboard-coordinator.js";
import type { UsageDisplayMode } from "../presentation/view-models/usage.js";

/**
 * Stream Deck persists settings as JSON, so every settings shape must stay
 * JSON-serialisable. Declared locally rather than pulled from a transitive
 * dependency of the SDK.
 */
export type SettingsValue =
	boolean | number | string | null | undefined | SettingsValue[] | { [key: string]: SettingsValue };

export interface UsageActionSettings {
	providerId?: string;
	windowMode?: "auto" | "pinned";
	windowId?: string;
	displayMode?: UsageDisplayMode;
	warnAtPercent?: number;
	dangerAtPercent?: number;
	showResetAt?: boolean;
	[key: string]: SettingsValue;
}

export interface AgentStatusActionSettings {
	providerId?: string;
	sessionMode?: "active" | "fixed";
	sessionId?: string;
	[key: string]: SettingsValue;
}

export interface StopActionSettings {
	providerId?: string;
	[key: string]: SettingsValue;
}

export interface GitActionSettings {
	repositoryPath?: string;
	[key: string]: SettingsValue;
}

export interface DashboardEncoderSettings {
	segment?: SegmentKind;
	providerId?: string;
	repositoryPath?: string;
	[key: string]: SettingsValue;
}
