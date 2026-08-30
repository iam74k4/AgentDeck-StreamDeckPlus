/**
 * Claude status payload → domain translation (design §10.2).
 *
 * Kept behind the `ClaudeUsageParser` interface the design names, with
 * fixture-backed tests, because this is the surface most likely to move when
 * Claude Code changes its status-line schema.
 */

import type { AgentSession } from "../../domain/session.js";
import type { UsageWindow } from "../../domain/usage.js";
import type { ClaudeRateLimitWindow, ClaudeStatusPayload } from "./status-payload.js";

export interface ClaudeUsageParser {
	parse(raw: unknown): UsageWindow[];
}

/** Window ids are stable so a pinned selection survives a restart (design §7.5). */
const WINDOWS = [
	{ key: "five_hour", id: "claude.five_hour", label: "5h", durationMinutes: 300 },
	{ key: "seven_day", id: "claude.seven_day", label: "7d", durationMinutes: 10_080 },
	// The spend limit has no fixed period, so it carries no duration.
	{ key: "spend_limit", id: "claude.spend_limit", label: "Spend" },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toWindow(
	definition: (typeof WINDOWS)[number],
	wire: ClaudeRateLimitWindow | null | undefined,
): UsageWindow | undefined {
	if (!isRecord(wire) || typeof wire.used_percentage !== "number" || !Number.isFinite(wire.used_percentage)) {
		return undefined;
	}

	const window: UsageWindow = {
		id: definition.id,
		label: definition.label,
		usedPercent: wire.used_percentage,
	};
	if ("durationMinutes" in definition) {
		window.windowDurationMinutes = definition.durationMinutes;
	}
	if (typeof wire.resets_at === "number" && Number.isFinite(wire.resets_at) && wire.resets_at > 0) {
		window.resetsAt = new Date(wire.resets_at * 1000);
	}
	return window;
}

export class StatusLineUsageParser implements ClaudeUsageParser {
	public parse(raw: unknown): UsageWindow[] {
		if (!isRecord(raw)) {
			return [];
		}
		const limits = (raw as ClaudeStatusPayload).rate_limits;
		if (!isRecord(limits)) {
			return [];
		}

		const windows: UsageWindow[] = [];
		for (const definition of WINDOWS) {
			const window = toWindow(definition, limits[definition.key] as ClaudeRateLimitWindow | undefined);
			if (window !== undefined) {
				windows.push(window);
			}
		}
		return windows;
	}
}

/**
 * Maps the payload onto a session.
 *
 * Claude Code's status line reports which session is open and what it costs, but
 * never whether a turn is running — so the state is `idle`, not a guess at
 * `working`. That is also why {@link ClaudeProvider} implements no `interrupt`:
 * the deck must not offer a STOP it cannot honour (design §12.2).
 */
export function parseSession(raw: unknown, providerId: string, capturedAt: Date): AgentSession | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const payload = raw as ClaudeStatusPayload;
	const id = payload.session_id;
	if (typeof id !== "string" || id.length === 0) {
		return undefined;
	}

	const session: AgentSession = {
		id,
		providerId,
		state: "idle",
		updatedAt: capturedAt,
	};

	const modelId = payload.model?.id;
	if (typeof modelId === "string" && modelId.length > 0) {
		session.modelId = modelId;
	}
	const label = payload.session_name ?? payload.model?.display_name;
	if (typeof label === "string" && label.length > 0) {
		session.label = label;
	}
	return session;
}
