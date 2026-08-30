/**
 * Usage domain model — design §7.3, §7.4, §7.5.
 *
 * Deliberately provider-agnostic: no Codex or Claude wire shape may appear here.
 */

import type { AgentDeckErrorCode } from "./errors.js";

export type ProviderId = string;

/**
 * A single rate-limit / quota window.
 *
 * The window duration is NOT fixed to 5h / 7d (design §7.3) — providers report
 * whatever windows they have, and the UI renders the label they supply.
 */
export interface UsageWindow {
	id: string;
	label: string;
	/** Raw percentage as reported by the provider. May exceed 100; clamp only when drawing. */
	usedPercent: number;
	windowDurationMinutes?: number;
	resetsAt?: Date;
}

export type ProviderStatus =
	"ready" | "loading" | "stale" | "login-required" | "cli-not-found" | "rate-limited" | "error";

export interface UsageError {
	code: AgentDeckErrorCode;
	message: string;
}

export interface UsageSnapshot {
	providerId: ProviderId;
	status: ProviderStatus;
	fetchedAt: Date;
	lastSuccessAt?: Date;
	windows: UsageWindow[];
	error?: UsageError;
}

export type WindowSelection = { mode: "auto" } | { mode: "pinned"; windowId: string };

/** Design §7.3: remaining is derived, never stored. */
export function remainingPercent(window: UsageWindow): number {
	return Math.max(0, 100 - window.usedPercent);
}

/** Design §7.3: only the drawn bar is clamped; the raw value is preserved on the model. */
export function clampBarPercent(usedPercent: number): number {
	if (!Number.isFinite(usedPercent)) {
		return 0;
	}
	return Math.min(100, Math.max(0, usedPercent));
}

/**
 * Picks the window an action should display.
 *
 * - `auto`   → the most constrained window (design §7.5, §18).
 * - `pinned` → exactly that window; when it disappears the caller renders `--`
 *              rather than silently substituting another one.
 */
export function selectWindow(
	windows: readonly UsageWindow[],
	selection: WindowSelection,
): UsageWindow | undefined {
	if (windows.length === 0) {
		return undefined;
	}
	if (selection.mode === "pinned") {
		return windows.find((w) => w.id === selection.windowId);
	}
	return mostConstrainedWindow(windows);
}

export function mostConstrainedWindow(windows: readonly UsageWindow[]): UsageWindow | undefined {
	let best: UsageWindow | undefined;
	for (const window of windows) {
		if (best === undefined || window.usedPercent > best.usedPercent) {
			best = window;
			continue;
		}
		// Tie-break on the window that resets soonest, so the display is deterministic.
		if (window.usedPercent === best.usedPercent) {
			const a = window.resetsAt?.getTime();
			const b = best.resetsAt?.getTime();
			if (a !== undefined && (b === undefined || a < b)) {
				best = window;
			}
		}
	}
	return best;
}

/** Maps a transport-level failure onto the provider status machine (design §17.3). */
export function providerStatusForError(code: AgentDeckErrorCode, hasCachedSnapshot: boolean): ProviderStatus {
	switch (code) {
		case "NOT_AUTHENTICATED":
			return "login-required";
		case "CLI_NOT_FOUND":
			return "cli-not-found";
		case "RATE_LIMITED":
			return "rate-limited";
		default:
			return hasCachedSnapshot ? "stale" : "error";
	}
}
