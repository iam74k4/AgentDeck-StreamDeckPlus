/**
 * Codex wire → AgentDeck domain translation (instructions §2.3).
 *
 * This is the boundary: above it nothing knows what a `RateLimitSnapshot` is.
 */

import type { AgentSession, AgentSessionState } from "../../domain/session.js";
import type { UsageWindow } from "../../domain/usage.js";
import type {
	WireAccountRateLimitsUpdated,
	WireGetAccountRateLimitsResponse,
	WireModel,
	WireRateLimitSnapshot,
	WireRateLimitWindow,
	WireThread,
	WireThreadStatus,
	WireTurnStatus,
} from "./protocol.js";
import type { ModelDescriptor } from "../../domain/model.js";

/** Bucket key used when the backend reports no `limitId`. */
export const DEFAULT_LIMIT_BUCKET = "default";

/**
 * Accumulated rate-limit state for one Codex account.
 *
 * Design §9.4: `account/rateLimits/updated` is a *sparse* update. Merging happens
 * here so a missing or `null` field can never wipe a value we already know.
 */
export interface CodexRateLimitState {
	/** Ordered by first appearance so window ordering stays stable across redraws. */
	buckets: Map<string, WireRateLimitSnapshot>;
}

export function createRateLimitState(): CodexRateLimitState {
	return { buckets: new Map() };
}

function bucketKey(snapshot: WireRateLimitSnapshot | null | undefined): string {
	const id = snapshot?.limitId;
	return typeof id === "string" && id.length > 0 ? id : DEFAULT_LIMIT_BUCKET;
}

/** Keeps `previous` wherever `update` reports nothing (design §9.4). */
function mergeWindow(
	previous: WireRateLimitWindow | null | undefined,
	update: WireRateLimitWindow | null | undefined,
): WireRateLimitWindow | undefined {
	if (update === null || update === undefined) {
		return previous ?? undefined;
	}
	const merged: WireRateLimitWindow = { ...(previous ?? {}) };
	if (typeof update.usedPercent === "number") {
		merged.usedPercent = update.usedPercent;
	}
	if (typeof update.windowDurationMins === "number") {
		merged.windowDurationMins = update.windowDurationMins;
	}
	if (typeof update.resetsAt === "number") {
		merged.resetsAt = update.resetsAt;
	}
	return merged;
}

export function mergeRateLimitSnapshot(
	previous: WireRateLimitSnapshot | undefined,
	update: WireRateLimitSnapshot,
): WireRateLimitSnapshot {
	const merged: WireRateLimitSnapshot = { ...(previous ?? {}) };

	if (typeof update.limitId === "string") {
		merged.limitId = update.limitId;
	}
	if (typeof update.limitName === "string") {
		merged.limitName = update.limitName;
	}
	if (typeof update.planType === "string") {
		merged.planType = update.planType;
	}
	if (typeof update.rateLimitReachedType === "string") {
		merged.rateLimitReachedType = update.rateLimitReachedType;
	}

	const primary = mergeWindow(previous?.primary, update.primary);
	if (primary !== undefined) {
		merged.primary = primary;
	}
	const secondary = mergeWindow(previous?.secondary, update.secondary);
	if (secondary !== undefined) {
		merged.secondary = secondary;
	}

	return merged;
}

/**
 * Applies a full `account/rateLimits/read` result.
 *
 * Buckets absent from a full read are dropped — the account no longer has them —
 * but each surviving bucket is still merged field-wise so descriptive fields the
 * read omits (e.g. `limitName`) are not lost.
 */
export function applyFullRateLimits(
	state: CodexRateLimitState,
	response: WireGetAccountRateLimitsResponse,
): CodexRateLimitState {
	const next = new Map<string, WireRateLimitSnapshot>();

	const primaryBucket = response.rateLimits;
	if (primaryBucket !== null && primaryBucket !== undefined) {
		const key = bucketKey(primaryBucket);
		next.set(key, mergeRateLimitSnapshot(state.buckets.get(key), primaryBucket));
	}

	const byId = response.rateLimitsByLimitId;
	if (byId !== null && byId !== undefined) {
		for (const [id, snapshot] of Object.entries(byId)) {
			if (snapshot === null || snapshot === undefined) {
				continue;
			}
			const key = typeof snapshot.limitId === "string" && snapshot.limitId.length > 0 ? snapshot.limitId : id;
			next.set(
				key,
				mergeRateLimitSnapshot(next.get(key) ?? state.buckets.get(key), { ...snapshot, limitId: key }),
			);
		}
	}

	return { buckets: next };
}

/** Applies a sparse `account/rateLimits/updated` notification. */
export function applyRateLimitsUpdate(
	state: CodexRateLimitState,
	update: WireAccountRateLimitsUpdated,
): CodexRateLimitState {
	const snapshot = update.rateLimits;
	if (snapshot === null || snapshot === undefined) {
		return state;
	}
	const key = bucketKey(snapshot);
	const buckets = new Map(state.buckets);
	buckets.set(key, mergeRateLimitSnapshot(state.buckets.get(key), snapshot));
	return { buckets };
}

/**
 * Renders a window duration as a key-sized label: `5h`, `7d`, `45m`.
 *
 * Design §7.3 — windows are whatever the provider reports; 5h/7d are not baked in.
 */
export function formatWindowLabel(minutes: number | null | undefined): string | undefined {
	if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
		return undefined;
	}
	if (minutes % 1440 === 0) {
		return `${minutes / 1440}d`;
	}
	if (minutes % 60 === 0) {
		return `${minutes / 60}h`;
	}
	if (minutes < 60) {
		return `${Math.round(minutes)}m`;
	}
	return `${Math.round(minutes / 60)}h`;
}

function unixSecondsToDate(seconds: number | null | undefined): Date | undefined {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
		return undefined;
	}
	return new Date(seconds * 1000);
}

function windowToDomain(
	bucket: string,
	slot: "primary" | "secondary",
	snapshot: WireRateLimitSnapshot,
	wire: WireRateLimitWindow | null | undefined,
	multiBucket: boolean,
): UsageWindow | undefined {
	if (wire === null || wire === undefined || typeof wire.usedPercent !== "number") {
		return undefined;
	}
	if (!Number.isFinite(wire.usedPercent)) {
		return undefined;
	}

	const durationLabel = formatWindowLabel(wire.windowDurationMins);
	const bucketLabel = multiBucket && typeof snapshot.limitName === "string" ? snapshot.limitName : undefined;
	const fallback = slot === "primary" ? "Primary" : "Secondary";
	const label = [bucketLabel, durationLabel ?? fallback].filter((part) => part !== undefined).join(" ");

	const window: UsageWindow = {
		id: `${bucket}.${slot}`,
		label,
		usedPercent: wire.usedPercent,
	};
	if (typeof wire.windowDurationMins === "number") {
		window.windowDurationMinutes = wire.windowDurationMins;
	}
	const resetsAt = unixSecondsToDate(wire.resetsAt);
	if (resetsAt !== undefined) {
		window.resetsAt = resetsAt;
	}
	return window;
}

/** Flattens the merged bucket state into the provider-agnostic window list. */
export function toUsageWindows(state: CodexRateLimitState): UsageWindow[] {
	const multiBucket = state.buckets.size > 1;
	const windows: UsageWindow[] = [];
	for (const [key, snapshot] of state.buckets) {
		for (const slot of ["primary", "secondary"] as const) {
			const window = windowToDomain(key, slot, snapshot, snapshot[slot], multiBucket);
			if (window !== undefined) {
				windows.push(window);
			}
		}
	}
	return windows;
}

/** True when Codex reports the account has hit a limit (design §17.3). */
export function isRateLimitReached(state: CodexRateLimitState): boolean {
	for (const snapshot of state.buckets.values()) {
		if (typeof snapshot.rateLimitReachedType === "string" && snapshot.rateLimitReachedType.length > 0) {
			return true;
		}
	}
	return false;
}

/**
 * Thread status → session state (design §7.2).
 *
 * `waitingOnUserInput` maps to `idle` rather than `working`: the agent is not
 * doing anything, and showing WORKING on a key would misreport it.
 */
export function threadStatusToSessionState(status: WireThreadStatus | null | undefined): AgentSessionState {
	if (status === null || status === undefined) {
		return "idle";
	}
	switch (status.type) {
		case "idle":
			return "idle";
		case "systemError":
			return "error";
		case "notLoaded":
			return "disconnected";
		case "active": {
			const flags = status.activeFlags ?? [];
			if (flags.includes("waitingOnApproval")) {
				return "waiting-approval";
			}
			if (flags.includes("waitingOnUserInput")) {
				return "idle";
			}
			return "working";
		}
		default:
			return "idle";
	}
}

export function turnStatusToSessionState(status: WireTurnStatus | null | undefined): AgentSessionState {
	switch (status) {
		case "inProgress":
			return "working";
		case "completed":
			return "completed";
		case "failed":
			return "error";
		case "interrupted":
			return "idle";
		default:
			return "idle";
	}
}

export function wireThreadToSession(
	thread: WireThread,
	providerId: string,
	now: Date = new Date(),
): AgentSession {
	const session: AgentSession = {
		id: thread.id,
		providerId,
		state: threadStatusToSessionState(thread.status),
		updatedAt: unixSecondsToDate(thread.updatedAt) ?? now,
	};
	const startedAt = unixSecondsToDate(thread.createdAt);
	if (startedAt !== undefined) {
		session.startedAt = startedAt;
	}
	const preview = typeof thread.preview === "string" ? thread.preview.trim() : "";
	if (preview.length > 0) {
		session.label = preview;
	}
	return session;
}

export function wireModelToDescriptor(model: WireModel): ModelDescriptor {
	const descriptor: ModelDescriptor = {
		id: model.id,
		label:
			typeof model.displayName === "string" && model.displayName.length > 0 ? model.displayName : model.id,
	};
	if (Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.length > 0) {
		descriptor.reasoningLevels = [...model.supportedReasoningEfforts];
	}
	return descriptor;
}
