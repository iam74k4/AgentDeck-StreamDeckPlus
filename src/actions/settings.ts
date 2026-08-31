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

export interface ApprovalActionSettings {
	/** Restricts the key to one provider's requests; empty follows every provider. */
	providerId?: string;
	/**
	 * How long a high-risk approval must be held (design §22.2). Only the Approve
	 * key reads it: Deny is always a single press.
	 */
	holdSeconds?: number;
	[key: string]: SettingsValue;
}

export interface PromptActionSettings {
	/** Empty follows the Prompt dial's selection. */
	presetId?: string;
	providerId?: string;
	/** A fixed prompt typed into the inspector; replaces the preset's input source. */
	text?: string;
	[key: string]: SettingsValue;
}

export interface VoiceActionSettings {
	/** Preset the transcript is sent through; empty follows the Prompt dial. */
	presetId?: string;
	providerId?: string;
	[key: string]: SettingsValue;
}

export interface ScreenshotActionSettings {
	/** Defaults to the Explain Screen preset. */
	presetId?: string;
	providerId?: string;
	/** Design §15.1 — Selected Region is future work. */
	captureMode?: "active-window" | "full-screen";
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
	/** Set by rotating a usage segment; `auto` follows the most constrained window. */
	windowMode?: "auto" | "pinned";
	windowId?: string;
	[key: string]: SettingsValue;
}

export interface ProjectActionSettings {
	/** Empty follows the active project; set to pin this key to one project. */
	projectId?: string;
	/** Adds and activates this path the first time the key is pressed. */
	addPath?: string;
	[key: string]: SettingsValue;
}

export interface LauncherActionSettings {
	appId?: string;
	/** Used when `appId` names nothing built in. */
	command?: string;
	/** Launch in the active project's directory. Defaults to true. */
	useActiveProject?: boolean;
	[key: string]: SettingsValue;
}
