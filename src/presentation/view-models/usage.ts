/**
 * Usage view model — design §7.3, §7.5, §17.
 */

import { errorBadge } from "../../domain/errors.js";
import { clampBarPercent, remainingPercent, selectWindow } from "../../domain/usage.js";
import type { UsageSnapshot, WindowSelection } from "../../domain/usage.js";
import { providerStatusColor, usageColor, Palette } from "./colors.js";

export type UsageDisplayMode = "used" | "remaining";

export interface UsageViewModelInput {
	providerLabel: string;
	snapshot?: UsageSnapshot;
	selection: WindowSelection;
	displayMode?: UsageDisplayMode;
	warnAtPercent?: number;
	dangerAtPercent?: number;
	showResetAt?: boolean;
	now?: Date;
}

export interface UsageViewModel {
	providerLabel: string;
	/** `42%`, or `--` when nothing can be shown. */
	valueText: string;
	windowLabel: string;
	detail: string;
	/** 0–100, already clamped for drawing (design §7.3). */
	barPercent: number;
	color: string;
	available: boolean;
}

const UNAVAILABLE = "--";

export function buildUsageViewModel(input: UsageViewModelInput): UsageViewModel {
	const snapshot = input.snapshot;
	const providerLabel = input.providerLabel;

	if (snapshot === undefined) {
		return unavailable(providerLabel, "…", Palette.idle);
	}

	if (
		snapshot.status === "cli-not-found" ||
		snapshot.status === "login-required" ||
		snapshot.status === "error"
	) {
		const badge = snapshot.error === undefined ? "ERROR" : errorBadge(snapshot.error.code);
		return unavailable(providerLabel, badge, providerStatusColor(snapshot.status));
	}

	const window = selectWindow(snapshot.windows, input.selection);
	if (window === undefined) {
		// Design §7.5: a pinned window that vanished shows `--`; it is not replaced.
		const badge = snapshot.status === "loading" ? "…" : UNAVAILABLE;
		return unavailable(providerLabel, badge, Palette.idle);
	}

	const mode = input.displayMode ?? "used";
	const shownPercent = mode === "used" ? window.usedPercent : remainingPercent(window);
	const barPercent = clampBarPercent(window.usedPercent);

	const stale = snapshot.status === "stale";
	const color = stale
		? Palette.warn
		: usageColor(window.usedPercent, input.warnAtPercent ?? 75, input.dangerAtPercent ?? 90);

	const detailParts: string[] = [];
	if (stale) {
		detailParts.push("STALE");
	}
	if (snapshot.status === "rate-limited") {
		detailParts.push("LIMIT");
	}
	if (input.showResetAt === true && window.resetsAt !== undefined) {
		detailParts.push(formatResetIn(window.resetsAt, input.now ?? new Date()));
	}

	return {
		providerLabel,
		valueText: `${Math.round(shownPercent)}%`,
		windowLabel: window.label,
		detail: detailParts.join(" "),
		barPercent,
		color,
		available: true,
	};
}

/** `resets 3h` / `resets 12m` — short enough for a 200x100 segment. */
export function formatResetIn(resetsAt: Date, now: Date): string {
	const minutes = Math.round((resetsAt.getTime() - now.getTime()) / 60_000);
	if (minutes <= 0) {
		return "resets now";
	}
	if (minutes < 60) {
		return `resets ${minutes}m`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return `resets ${hours}h`;
	}
	return `resets ${Math.round(hours / 24)}d`;
}

function unavailable(providerLabel: string, valueText: string, color: string): UsageViewModel {
	return {
		providerLabel,
		valueText,
		windowLabel: "",
		detail: "",
		barPercent: 0,
		color,
		available: false,
	};
}
