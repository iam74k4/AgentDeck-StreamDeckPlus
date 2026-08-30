/**
 * AI Overview view model — design §18.
 *
 * Providers are shown side by side and are never summed: there is no such thing
 * as an "AI Total" when the windows have different lengths and different plans
 * behind them. The headline names *which* provider is most constrained, and the
 * rest are listed after it.
 */

import type { ProviderOverviewEntry } from "../../application/usage-service.js";
import { clampBarPercent } from "../../domain/usage.js";
import { Palette, usageColor } from "./colors.js";

export interface OverviewViewModel {
	/** Provider and window of the most constrained reading, e.g. `CLAUDE 7d`. */
	headline: string;
	/** That reading's percentage, e.g. `96%`. */
	valueText: string;
	/** The remaining providers, compactly. */
	detail: string;
	barPercent: number;
	color: string;
	available: boolean;
}

function short(entry: ProviderOverviewEntry): string {
	const percent = entry.window === undefined ? "--" : `${Math.round(entry.window.usedPercent)}%`;
	const label = entry.window?.label ?? "";
	return `${entry.displayName} ${percent}${label.length > 0 ? ` ${label}` : ""}`;
}

export function buildOverviewViewModel(entries: readonly ProviderOverviewEntry[]): OverviewViewModel {
	const withWindows = entries.filter((entry) => entry.window !== undefined);

	if (withWindows.length === 0) {
		return {
			headline: "AI OVERVIEW",
			valueText: entries.length === 0 ? "--" : "…",
			detail: entries.map((entry) => entry.displayName).join(" · "),
			barPercent: 0,
			color: Palette.idle,
			available: false,
		};
	}

	// Most constrained first; the rest keep registration order behind it.
	const ranked = [...withWindows].sort((a, b) => (b.window?.usedPercent ?? 0) - (a.window?.usedPercent ?? 0));
	const leader = ranked[0];
	if (leader?.window === undefined) {
		return {
			headline: "AI OVERVIEW",
			valueText: "--",
			detail: "",
			barPercent: 0,
			color: Palette.idle,
			available: false,
		};
	}

	// Every registered provider stays visible, including ones reporting nothing:
	// a Claude row reading `--` is how the user learns the bridge is not set up.
	const others = entries.filter((entry) => entry !== leader);
	const stale = leader.status === "stale";

	return {
		headline: `${leader.displayName.toUpperCase()} ${leader.window.label}`.trim(),
		valueText: `${Math.round(leader.window.usedPercent)}%`,
		detail: [stale ? "STALE" : "", ...others.map(short)].filter((part) => part.length > 0).join(" · "),
		barPercent: clampBarPercent(leader.window.usedPercent),
		color: stale ? Palette.warn : usageColor(leader.window.usedPercent),
		available: true,
	};
}
