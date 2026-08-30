/**
 * Codex app-server wire contract — the ONLY place Codex JSON shapes may appear
 * (instructions §2.3). Everything above `mapper.ts` speaks the domain model.
 *
 * Design §9.6: these are a deliberately narrow, tolerant read model, not a
 * hand-maintained copy of the full protocol. When the Codex CLI is available,
 * `npm run codex:generate-types` writes the authoritative types into
 * `src/generated/codex/`; the mapper is the single place that would need to
 * switch over to them.
 *
 * Verified against openai/codex `codex-rs/app-server-protocol` (protocol/v2,
 * serde `rename_all = "camelCase"`) and `codex-rs/app-server/README.md`.
 */

/**
 * Methods this plugin actually calls (design §9.3 — stable API surface only).
 *
 * Deliberately not a catalogue of the whole protocol: `account/usage/read` and
 * `turn/steer` belong to later milestones and are added when their callers land.
 */
export const CodexMethod = {
	Initialize: "initialize",
	Initialized: "initialized",
	AccountRead: "account/read",
	AccountRateLimitsRead: "account/rateLimits/read",
	ThreadList: "thread/list",
	ThreadRead: "thread/read",
	TurnInterrupt: "turn/interrupt",
	ModelList: "model/list",
} as const;

/** Notifications this plugin subscribes to (design §9.3, §20.1). */
export const CodexNotification = {
	AccountRateLimitsUpdated: "account/rateLimits/updated",
	ThreadStarted: "thread/started",
	ThreadStatusChanged: "thread/status/changed",
	TurnStarted: "turn/started",
	TurnCompleted: "turn/completed",
	ItemStarted: "item/started",
	ItemCompleted: "item/completed",
} as const;

export interface WireClientInfo {
	name: string;
	title?: string;
	version: string;
}

export interface WireInitializeParams {
	clientInfo: WireClientInfo;
	capabilities?: {
		experimentalApi?: boolean;
		optOutNotificationMethods?: string[];
	};
}

export interface WireInitializeResponse {
	userAgent?: string;
	codexHome?: string;
	platformFamily?: string;
	platformOs?: string;
}

/** `RateLimitWindow` — `usedPercent` is an integer percentage. */
export interface WireRateLimitWindow {
	usedPercent?: number | null;
	/** Window length in minutes; absent when the backend does not report it. */
	windowDurationMins?: number | null;
	/** Unix timestamp in seconds. */
	resetsAt?: number | null;
}

/**
 * `RateLimitSnapshot`.
 *
 * Every member is nullable. A `null` means "not reported", which per design §9.4
 * must NOT erase a previously known value.
 */
export interface WireRateLimitSnapshot {
	limitId?: string | null;
	limitName?: string | null;
	primary?: WireRateLimitWindow | null;
	secondary?: WireRateLimitWindow | null;
	planType?: string | null;
	rateLimitReachedType?: string | null;
}

/** `account/rateLimits/read` result. */
export interface WireGetAccountRateLimitsResponse {
	rateLimits?: WireRateLimitSnapshot | null;
	/** Multi-bucket view keyed by metered limit id (e.g. `codex`). */
	rateLimitsByLimitId?: Record<string, WireRateLimitSnapshot> | null;
}

/** `account/rateLimits/updated` params — a possibly sparse snapshot. */
export interface WireAccountRateLimitsUpdated {
	rateLimits?: WireRateLimitSnapshot | null;
}

/** `account/read` result — an internally tagged union; only the tag is consumed. */
export interface WireAccount {
	type?: string;
	email?: string | null;
	planType?: string | null;
}

export type WireThreadStatus =
	| { type: "notLoaded" }
	| { type: "idle" }
	| { type: "systemError" }
	| { type: "active"; activeFlags?: string[] };

export interface WireThread {
	id: string;
	preview?: string | null;
	status?: WireThreadStatus | null;
	createdAt?: number | null;
	updatedAt?: number | null;
}

export interface WireThreadListResponse {
	data?: WireThread[] | null;
	nextCursor?: string | null;
}

export type WireTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface WireTurn {
	id: string;
	status?: WireTurnStatus | null;
	tokenUsage?: { inputTokens?: number | null; outputTokens?: number | null } | null;
}

export interface WireTurnNotification {
	threadId?: string;
	turn?: WireTurn | null;
}

export interface WireThreadStatusChanged {
	threadId?: string;
	status?: WireThreadStatus | null;
}

export interface WireThreadStartedNotification {
	thread?: WireThread | null;
}

export interface WireModel {
	id: string;
	displayName?: string | null;
	supportedReasoningEfforts?: string[] | null;
}

export interface WireModelListResponse {
	data?: WireModel[] | null;
}
