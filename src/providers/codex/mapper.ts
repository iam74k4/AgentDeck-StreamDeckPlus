/**
 * Codex wire → AgentDeck domain translation (instructions §2.3).
 *
 * This is the boundary: above it nothing knows what a `RateLimitSnapshot` is.
 */

import type { DiffSummary } from "../../domain/git.js";
import type { AgentSession, AgentSessionState, PlanSummary } from "../../domain/session.js";
import type { UsageWindow } from "../../domain/usage.js";
import type {
	WireAccount,
	WireAccountRateLimitsUpdated,
	WireGetAccountRateLimitsResponse,
	WireModel,
	WireRateLimitSnapshot,
	WireRateLimitWindow,
	WireThread,
	WireFileChangeItem,
	WirePlanItem,
	WireThreadSettings,
	WireThreadStatus,
	WireTurnStatus,
	WireUserInput,
} from "./protocol.js";
import type { ModelDescriptor } from "../../domain/model.js";
import type { AgentInput } from "../provider.js";

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
 * `rateLimits` is documented upstream as the "backward-compatible single-bucket
 * view": it mirrors one of the entries in `rateLimitsByLimitId` rather than
 * describing a bucket of its own. Merging both would show the same quota twice,
 * so the keyed map wins whenever it has entries and the unkeyed view is used
 * only when that map is absent or empty.
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

	const byId = Object.entries(response.rateLimitsByLimitId ?? {}).filter(
		(entry): entry is [string, WireRateLimitSnapshot] => entry[1] !== null && entry[1] !== undefined,
	);

	if (byId.length > 0) {
		for (const [id, snapshot] of byId) {
			const key = typeof snapshot.limitId === "string" && snapshot.limitId.length > 0 ? snapshot.limitId : id;
			next.set(key, mergeRateLimitSnapshot(state.buckets.get(key), { ...snapshot, limitId: key }));
		}
		return { buckets: next };
	}

	const single = response.rateLimits;
	if (single !== null && single !== undefined) {
		const key = bucketKey(single);
		next.set(key, mergeRateLimitSnapshot(state.buckets.get(key), single));
	}
	return { buckets: next };
}

/**
 * Applies a sparse `account/rateLimits/updated` notification.
 *
 * An update carrying no `limitId` is that same single-bucket view, so when
 * exactly one bucket is known it updates that bucket instead of inventing a
 * second one beside it.
 */
export function applyRateLimitsUpdate(
	state: CodexRateLimitState,
	update: WireAccountRateLimitsUpdated,
): CodexRateLimitState {
	const snapshot = update.rateLimits;
	if (snapshot === null || snapshot === undefined) {
		return state;
	}
	const key = resolveUpdateBucket(state, snapshot);
	const buckets = new Map(state.buckets);
	buckets.set(key, mergeRateLimitSnapshot(state.buckets.get(key), snapshot));
	return { buckets };
}

function resolveUpdateBucket(state: CodexRateLimitState, snapshot: WireRateLimitSnapshot): string {
	if (typeof snapshot.limitId === "string" && snapshot.limitId.length > 0) {
		return snapshot.limitId;
	}
	const known = [...state.buckets.keys()];
	return known.length === 1 ? (known[0] ?? DEFAULT_LIMIT_BUCKET) : DEFAULT_LIMIT_BUCKET;
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

/**
 * Decides whether Codex is signed in, from the shape of `account/read`.
 *
 * `Account` is an internally tagged union (`apiKey` / `chatgpt` / `amazonBedrock`),
 * so the presence of a tag is the signal. Instructions §10: this is what replaces
 * matching "not logged in" against an error message.
 */
export function isAuthenticatedAccount(account: WireAccount | null | undefined): boolean {
	return typeof account?.type === "string" && account.type.length > 0;
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

/**
 * Domain input → Codex `UserInput` items.
 *
 * Empty text is dropped rather than sent: an accidental key press must not start
 * a turn with nothing in it.
 */
export function toWireUserInput(input: AgentInput): WireUserInput[] {
	const items: WireUserInput[] = [];
	const text = input.text?.trim();
	if (text !== undefined && text.length > 0) {
		items.push({ type: "text", text });
	}
	for (const path of input.imagePaths ?? []) {
		if (path.length > 0) {
			items.push({ type: "localImage", path });
		}
	}
	return items;
}

/**
 * Reads `Plan n/m` out of a Codex plan item.
 *
 * The item carries free text rather than structured steps, and Codex renders its
 * plan as a markdown checklist. Only checklist lines are counted: text with no
 * checkboxes is prose, and reporting `Plan 0/0` for it would put a number on the
 * deck that means nothing.
 *
 * Marked experimental upstream, so the shape may change — which is another
 * reason to return `undefined` rather than guess.
 */
export function parsePlanProgress(item: WirePlanItem | undefined): PlanSummary | undefined {
	const text = item?.text;
	if (typeof text !== "string" || text.length === 0) {
		return undefined;
	}

	let completedSteps = 0;
	let totalSteps = 0;
	for (const line of text.split("\n")) {
		const match = /^\s*(?:[-*+]|\d+[.)])\s*\[( |x|X|✓|✔)\]/.exec(line);
		if (match === null) {
			continue;
		}
		totalSteps += 1;
		if (match[1] !== " ") {
			completedSteps += 1;
		}
	}

	return totalSteps === 0 ? undefined : { completedSteps, totalSteps };
}

/**
 * Counts the lines a Codex file-change item would add and remove.
 *
 * The item gives a unified diff per file, so the counts come from the diff body:
 * `+`/`-` lines, excluding the `+++`/`---` headers, which are file names rather
 * than content.
 */
export function fileChangeToDiffSummary(item: WireFileChangeItem | undefined): DiffSummary | undefined {
	const counts = fileChangeCounts(item);
	return counts === undefined ? undefined : summariseFileCounts(counts);
}

/** Lines added and removed, per file path. */
export type FileChangeCounts = Map<string, { added: number; removed: number }>;

/**
 * Per-path counts from one Codex file-change item.
 *
 * Kept per path so a turn's items can be merged: two items patching two files
 * are two files, and two items patching the *same* file is still one.
 */
export function fileChangeCounts(item: WireFileChangeItem | undefined): FileChangeCounts | undefined {
	const changes = item?.changes;
	if (!Array.isArray(changes) || changes.length === 0) {
		return undefined;
	}

	const counts: FileChangeCounts = new Map();
	for (const change of changes) {
		if (change === null || change === undefined || typeof change.path !== "string") {
			continue;
		}
		let added = 0;
		let removed = 0;
		for (const line of typeof change.diff === "string" ? change.diff.split("\n") : []) {
			// `+++`/`---` name the files rather than changing lines.
			if (line.startsWith("+++") || line.startsWith("---")) {
				continue;
			}
			if (line.startsWith("+")) {
				added += 1;
			} else if (line.startsWith("-")) {
				removed += 1;
			}
		}
		counts.set(change.path, { added, removed });
	}

	return counts.size === 0 ? undefined : counts;
}

export function summariseFileCounts(counts: FileChangeCounts): DiffSummary {
	let added = 0;
	let removed = 0;
	for (const entry of counts.values()) {
		added += entry.added;
		removed += entry.removed;
	}
	return { added, removed, fileCount: counts.size };
}

/**
 * Folds a thread's settings into the session.
 *
 * Only fields that are actually present change anything: Codex sends the whole
 * settings object, but a missing `cwd` must not erase one the deck already knows.
 */
export function applyThreadSettings(
	session: AgentSession,
	settings: WireThreadSettings | undefined,
): AgentSession {
	if (settings === null || settings === undefined) {
		return session;
	}
	const next: AgentSession = { ...session };
	if (typeof settings.cwd === "string" && settings.cwd.length > 0) {
		next.cwd = settings.cwd;
	}
	if (typeof settings.model === "string" && settings.model.length > 0) {
		next.modelId = settings.model;
	}
	if (typeof settings.effort === "string" && settings.effort.length > 0) {
		next.reasoningLevel = settings.effort;
	}
	return next;
}
