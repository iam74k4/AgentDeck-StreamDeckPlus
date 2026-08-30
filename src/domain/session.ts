/**
 * Agent session domain model — design §7.2.
 */

import type { ProviderId } from "./usage.js";

export type AgentSessionState =
	"idle" | "starting" | "working" | "waiting-approval" | "completed" | "error" | "disconnected";

/** Reserved for v0.4 (design §5.4); modelled now so the interface boundary stays stable. */
export interface PlanSummary {
	completedSteps: number;
	totalSteps: number;
}

/** Reserved for v0.4 (design §5.4). */
export interface DiffSummary {
	added: number;
	removed: number;
	fileCount: number;
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
