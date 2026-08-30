/**
 * Claude Code status-line payload — the ONLY place this wire shape may appear
 * (instructions §2.3, design §3.3).
 *
 * Spike D established that Claude Code exposes no local usage cache and no CLI
 * command to poll, but it does hand a documented JSON payload to whatever
 * `statusLine` command the user configures. AgentDeck receives that payload
 * through its bridge, so nothing here needs a credential (design §10.3).
 *
 * Every member is optional on purpose: fields arrive and disappear across Claude
 * Code versions, and a missing one must degrade the display, never throw.
 * Verified against Claude Code 2.1.251 and the published status-line reference.
 */

/** One rate-limit window as Claude Code reports it. */
export interface ClaudeRateLimitWindow {
	/** 0–100, and above 100 once a spend limit is exceeded. */
	used_percentage?: number | null;
	/** Unix timestamp in seconds. */
	resets_at?: number | null;
}

export interface ClaudeRateLimits {
	five_hour?: ClaudeRateLimitWindow | null;
	seven_day?: ClaudeRateLimitWindow | null;
	/** Only present behind a Claude apps gateway; may exceed 100. */
	spend_limit?: ClaudeRateLimitWindow | null;
}

export interface ClaudeStatusPayload {
	session_id?: string | null;
	session_name?: string | null;
	cwd?: string | null;
	version?: string | null;
	model?: { id?: string | null; display_name?: string | null } | null;
	workspace?: { current_dir?: string | null; project_dir?: string | null } | null;
	cost?: { total_cost_usd?: number | null; total_duration_ms?: number | null } | null;
	context_window?: { used_percentage?: number | null; context_window_size?: number | null } | null;
	rate_limits?: ClaudeRateLimits | null;
}

/**
 * What AgentDeck's bridge writes, wrapping the payload with the time it arrived.
 *
 * Claude Code only runs the status-line command while a session is open, so the
 * reading has to carry its own timestamp: without it a snapshot from yesterday
 * would be indistinguishable from one taken a second ago.
 */
export interface ClaudeStatusEnvelope {
	/** Bridge format version, so an old file can be rejected rather than misread. */
	v?: number;
	/** Unix timestamp in milliseconds, written by the bridge. */
	capturedAt?: number;
	status?: ClaudeStatusPayload;
}

export const CLAUDE_BRIDGE_FORMAT = 1;
