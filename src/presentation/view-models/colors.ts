/**
 * Shared palette for keys and touch-strip segments.
 *
 * Colours carry meaning at a glance (design §3.5): the deck is read, not studied.
 */

import type { AgentSessionState } from "../../domain/session.js";
import type { ProviderStatus } from "../../domain/usage.js";

export const Palette = {
	background: "#101114",
	surface: "#1b1d22",
	text: "#f2f3f5",
	textMuted: "#9aa0a6",
	accent: "#3d8bfd",
	ok: "#2fbf71",
	warn: "#e0a800",
	danger: "#e5484d",
	idle: "#7a7f87",
	offline: "#4a4d52",
} as const;

const SESSION_STATE_COLORS: Readonly<Record<AgentSessionState, string>> = {
	idle: Palette.idle,
	starting: Palette.warn,
	working: Palette.ok,
	"waiting-approval": Palette.warn,
	completed: Palette.accent,
	error: Palette.danger,
	disconnected: Palette.offline,
};

export function sessionStateColor(state: AgentSessionState): string {
	return SESSION_STATE_COLORS[state];
}

const PROVIDER_STATUS_COLORS: Readonly<Record<ProviderStatus, string>> = {
	ready: Palette.ok,
	loading: Palette.idle,
	stale: Palette.warn,
	"login-required": Palette.warn,
	"cli-not-found": Palette.danger,
	"rate-limited": Palette.danger,
	error: Palette.danger,
};

export function providerStatusColor(status: ProviderStatus): string {
	return PROVIDER_STATUS_COLORS[status];
}

/** Colour for a usage bar given the configured warning threshold (design §23.2). */
export function usageColor(usedPercent: number, warnAtPercent = 75, dangerAtPercent = 90): string {
	if (usedPercent >= dangerAtPercent) {
		return Palette.danger;
	}
	if (usedPercent >= warnAtPercent) {
		return Palette.warn;
	}
	return Palette.ok;
}
