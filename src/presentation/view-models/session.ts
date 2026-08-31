/**
 * Session view model — design §6.1 dial 2, §7.2.
 *
 * The dial answers "which conversation am I driving", so the segment names the
 * session, says what it is doing, and says whether it is pinned. Pinned matters:
 * a pinned session is the one every "active session" key follows, and the deck
 * should never leave that ambiguous.
 */

import { formatDiffSummary } from "../../domain/git.js";
import type { AgentSession } from "../../domain/session.js";
import { formatPlanProgress, sessionStateLabel } from "../../domain/session.js";
import { sessionStateColor, Palette } from "./colors.js";

export interface SessionViewModel {
	/** The session's own label, or a short form of its id. */
	name: string;
	/** State plus whatever the session has to report: plan, diff, tokens. */
	detail: string;
	/** `2/5` while there is more than one session to rotate through. */
	position: string;
	color: string;
	pinned: boolean;
	available: boolean;
}

/** Ids are long and opaque; the tail is the part that differs between them. */
export function shortSessionId(id: string): string {
	return id.length <= 10 ? id : `…${id.slice(-8)}`;
}

export function formatTokenUsage(session: AgentSession): string {
	const usage = session.tokenUsage;
	if (usage === undefined) {
		return "";
	}
	const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
	if (total === 0) {
		return "";
	}
	return total >= 1000 ? `${Math.round(total / 100) / 10}k tok` : `${total} tok`;
}

export function buildSessionViewModel(input: {
	session?: AgentSession;
	/** Position within the rotation, when there is more than one. */
	index?: number;
	total?: number;
	pinnedSessionId?: string;
}): SessionViewModel {
	const session = input.session;
	if (session === undefined) {
		return {
			name: "NO SESSION",
			detail: input.total === 0 ? "nothing running" : "",
			position: "",
			color: Palette.offline,
			pinned: false,
			available: false,
		};
	}

	const pinned = input.pinnedSessionId === session.id;
	// Whatever the session has to say, most specific first: the plan says where it
	// is, the diff says what it did, tokens are the fallback signal of activity.
	const extra =
		formatPlanProgress(session.plan) || formatDiffSummary(session.diff) || formatTokenUsage(session);

	return {
		name: session.label ?? shortSessionId(session.id),
		detail: [sessionStateLabel(session.state), extra].filter((part) => part.length > 0).join(" · "),
		position:
			input.total !== undefined && input.total > 1 && input.index !== undefined
				? `${input.index + 1}/${input.total}`
				: "",
		color: sessionStateColor(session.state),
		pinned,
		available: true,
	};
}
