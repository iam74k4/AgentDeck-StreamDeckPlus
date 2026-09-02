/**
 * Agent session domain model — design §7.2.
 */

import type { DiffSummary } from "./git.js";
import type { ProviderId } from "./usage.js";

export type AgentSessionState =
	"idle" | "starting" | "working" | "waiting-approval" | "completed" | "error" | "disconnected";

/**
 * Design §3.5 — `Plan 2/4`.
 *
 * How far through its own plan the agent says it is. Steps are counted, never
 * listed: the deck shows progress, and the plan itself belongs in the agent's
 * own UI.
 */
export interface PlanSummary {
	completedSteps: number;
	totalSteps: number;
}

export interface SessionTokenUsage {
	inputTokens?: number;
	outputTokens?: number;
}

export interface AgentSession {
	id: string;
	providerId: ProviderId;
	projectId?: string;

	state: AgentSessionState;
	startedAt?: Date;
	updatedAt: Date;

	currentTurnId?: string;
	modelId?: string;
	reasoningLevel?: string;

	/**
	 * Where the agent is working.
	 *
	 * Not in design §7.2, which carries `projectId`. The two are different
	 * questions: `projectId` is the project the user chose, and this is the
	 * directory the provider reports. Keeping both is what lets the deck adopt a
	 * project the user never had to type in, without overriding one they picked.
	 */
	cwd?: string;

	label?: string;

	plan?: PlanSummary;
	diff?: DiffSummary;
	tokenUsage?: SessionTokenUsage;
}

const KEY_LABELS: Readonly<Record<AgentSessionState, string>> = {
	idle: "IDLE",
	starting: "STARTING",
	working: "WORKING",
	"waiting-approval": "APPROVAL",
	completed: "DONE",
	error: "ERROR",
	disconnected: "OFFLINE",
};

/** Design §12.1 — short, key-sized status text. */
export function sessionStateLabel(state: AgentSessionState): string {
	return KEY_LABELS[state];
}

/** A session is interruptible only while the provider is actually running a turn. */
export function isInterruptible(session: AgentSession | undefined): session is AgentSession {
	return session !== undefined && (session.state === "working" || session.state === "waiting-approval");
}

/**
 * Chooses the session an "active session" action should follow.
 *
 * Working sessions win over idle ones; ties break on the most recently updated.
 */
export function pickActiveSession(sessions: readonly AgentSession[]): AgentSession | undefined {
	const rank: Record<AgentSessionState, number> = {
		working: 5,
		"waiting-approval": 4,
		starting: 3,
		idle: 2,
		completed: 1,
		error: 1,
		disconnected: 0,
	};
	let best: AgentSession | undefined;
	for (const session of sessions) {
		if (best === undefined) {
			best = session;
			continue;
		}
		const delta = rank[session.state] - rank[best.state];
		if (delta > 0 || (delta === 0 && session.updatedAt.getTime() > best.updatedAt.getTime())) {
			best = session;
		}
	}
	return best;
}

/** Design §3.5 — `Plan 2/4`, or an empty string when there is no plan. */
export function formatPlanProgress(plan: PlanSummary | undefined): string {
	if (plan === undefined || plan.totalSteps === 0) {
		return "";
	}
	return `Plan ${plan.completedSteps}/${plan.totalSteps}`;
}
