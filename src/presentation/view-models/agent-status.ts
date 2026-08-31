/**
 * Agent status view model — design §12.1.
 *
 * Actions render a view model; they never read provider state directly
 * (instructions §9).
 */

import type { AgentSession } from "../../domain/session.js";
import { formatPlanProgress, sessionStateLabel } from "../../domain/session.js";
import { errorBadge, type AgentDeckErrorCode } from "../../domain/errors.js";
import type { ProviderStatus } from "../../domain/usage.js";
import { sessionStateColor, providerStatusColor, Palette } from "./colors.js";

export interface AgentStatusViewModel {
	providerLabel: string;
	stateLabel: string;
	detail: string;
	color: string;
	/**
	 * `Plan 2/4`, or empty when the agent has not published one.
	 *
	 * Separate from `detail` because the two surfaces want different things: a key
	 * has room for the elapsed time (design §12.1), the touch strip's detail row
	 * shows the plan beside it (design §6.1).
	 */
	plan: string;
	/** Drives whether the STOP key renders as available. */
	interruptible: boolean;
}

export interface AgentStatusInput {
	providerLabel: string;
	providerStatus: ProviderStatus;
	/** Distinguishes "sign in" from "the bridge was never set up". */
	errorCode?: AgentDeckErrorCode;
	session?: AgentSession;
	now?: Date;
}

/** `02:18` — elapsed time in the current turn (design §12.1). */
export function formatElapsed(from: Date, now: Date): string {
	const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}`;
}

export function buildAgentStatusViewModel(input: AgentStatusInput): AgentStatusViewModel {
	const now = input.now ?? new Date();

	// A provider that is not usable outranks any stale session state we still hold.
	if (input.providerStatus === "cli-not-found") {
		return {
			providerLabel: input.providerLabel,
			stateLabel: "CLI?",
			detail: "not found",
			color: providerStatusColor(input.providerStatus),
			plan: "",
			interruptible: false,
		};
	}
	if (input.providerStatus === "login-required") {
		// `login-required` covers both "not signed in" and "bridge not configured";
		// only the error code separates them, so the badge comes from there.
		const notConfigured = input.errorCode === "NOT_CONFIGURED";
		return {
			providerLabel: input.providerLabel,
			stateLabel: notConfigured ? errorBadge("NOT_CONFIGURED") : "LOGIN",
			detail: notConfigured ? "setup needed" : "sign in",
			color: providerStatusColor(input.providerStatus),
			plan: "",
			interruptible: false,
		};
	}

	const session = input.session;
	if (session === undefined) {
		const loading = input.providerStatus === "loading";
		return {
			providerLabel: input.providerLabel,
			stateLabel: loading ? "…" : "NO SESSION",
			detail: loading ? "connecting" : "",
			color: loading ? Palette.idle : Palette.offline,
			plan: "",
			interruptible: false,
		};
	}

	const working = session.state === "working";
	const detail =
		working && session.startedAt !== undefined
			? formatElapsed(session.startedAt, now)
			: (session.label ?? "").slice(0, 18);

	return {
		providerLabel: input.providerLabel,
		stateLabel: sessionStateLabel(session.state),
		detail,
		color: sessionStateColor(session.state),
		plan: formatPlanProgress(session.plan),
		interruptible: session.state === "working" || session.state === "waiting-approval",
	};
}
