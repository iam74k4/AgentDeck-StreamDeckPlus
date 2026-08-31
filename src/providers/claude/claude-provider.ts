/**
 * Claude provider — design §10, v0.2 "Claude Usage Provider".
 *
 * Monitoring only, and deliberately so. Spike D found that Claude Code exposes
 * rate-limit percentages through its status line but no control channel and no
 * signal for whether a turn is currently running, so this provider implements
 * `refreshUsage` and `listSessions` and omits `interrupt` / `steer`. Those are
 * optional members of {@link AgentProvider} precisely so a provider can decline
 * them, and omitting `interrupt` is what keeps the STOP key from offering an
 * action the deck cannot honour (design §12.2).
 *
 * No credential is read, stored or transmitted: Claude Code pushes the data to
 * AgentDeck's bridge, and the bridge writes only what Claude Code handed it
 * (design §10.3, §22.1).
 */

import type { ProviderEvent, ProviderEventListener, Unsubscribe } from "../../domain/provider-events.js";
import { toAgentDeckError, type AgentDeckError } from "../../domain/errors.js";
import type { AgentSession } from "../../domain/session.js";
import {
	providerStatusForError,
	type ProviderStatus,
	type UsageSnapshot,
	type UsageWindow,
} from "../../domain/usage.js";
import type { Logger } from "../../infrastructure/logger.js";
import { createLogger, nullSink } from "../../infrastructure/logger.js";
import { scheduleInterval, type ScheduledTask } from "../../infrastructure/scheduler.js";
import type { AgentProvider, ProviderLifecycleState } from "../provider.js";
import { agentDeckDataDir } from "./bridge-path.js";
import { parseSession, StatusLineUsageParser, type ClaudeUsageParser } from "./claude-usage-parser.js";
import { ClaudeStatusFileSource } from "./status-file-source.js";

export const CLAUDE_PROVIDER_ID = "claude";

/** Design §17.4 — Claude refresh interval, floored so a typo cannot spin. */
export const MIN_CLAUDE_REFRESH_INTERVAL_MS = 5_000;

export interface ClaudeProviderOptions {
	logger?: Logger;
	/** Overrides the directory the status-line bridge writes into. */
	statusDir?: string;
	/** Design §17.4 — Claude refresh interval. */
	refreshIntervalMs?: number;
	/** How long a bridge reading stays current before it reads as stale. */
	freshnessMs?: number;
	/** Test seams. */
	source?: ClaudeStatusFileSource;
	parser?: ClaudeUsageParser;
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
}

function clampRefreshInterval(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 30_000;
	}
	return Math.max(MIN_CLAUDE_REFRESH_INTERVAL_MS, value);
}

export class ClaudeProvider implements AgentProvider {
	public readonly id = CLAUDE_PROVIDER_ID;
	public readonly displayName = "Claude";

	readonly #logger: Logger;
	readonly #source: ClaudeStatusFileSource;
	readonly #parser: ClaudeUsageParser;
	readonly #listeners = new Set<ProviderEventListener>();
	readonly #now: () => Date;
	#refreshIntervalMs: number;

	#state: ProviderLifecycleState = "stopped";
	#windows: UsageWindow[] = [];
	#session: AgentSession | undefined;
	#lastSuccessAt: Date | undefined;
	#lastError: AgentDeckError | undefined;
	#stale = false;
	#poll: ScheduledTask | undefined;

	public constructor(options: ClaudeProviderOptions = {}) {
		this.#logger = (options.logger ?? createLogger({ sink: nullSink })).child("claude");
		this.#now = options.now ?? (() => new Date());
		this.#refreshIntervalMs = clampRefreshInterval(options.refreshIntervalMs);
		this.#parser = options.parser ?? new StatusLineUsageParser();
		this.#source =
			options.source ??
			new ClaudeStatusFileSource({
				dir: options.statusDir ?? agentDeckDataDir(options.env),
				logger: this.#logger,
				...(options.freshnessMs === undefined ? {} : { freshnessMs: options.freshnessMs }),
				...(options.now === undefined ? {} : { now: options.now }),
			});
	}

	public get lifecycleState(): ProviderLifecycleState {
		return this.#state;
	}

	/**
	 * Design §17.3, adapted to a push transport: a reading that has stopped
	 * arriving is STALE, and a bridge that has never run reads as LOGIN — the
	 * user has something to do about it either way.
	 */
	public get status(): ProviderStatus {
		if (this.#lastError !== undefined) {
			return providerStatusForError(this.#lastError.code, this.#windows.length > 0);
		}
		if (this.#lastSuccessAt === undefined) {
			return "loading";
		}
		// Deliberately independent of the lifecycle state: this provider holds no
		// connection, so "are we polling" says nothing about whether the reading on
		// screen is good. Only the age of the reading does.
		return this.#stale ? "stale" : "ready";
	}

	/** Where the bridge writes; surfaced for diagnostics and setup guidance. */
	public get bridgeDir(): string {
		return this.#source.dir;
	}

	public subscribe(listener: ProviderEventListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Available once the bridge has written at least one reading. */
	public async isAvailable(): Promise<boolean> {
		return this.#source.isConfigured();
	}

	public async start(): Promise<void> {
		if (this.#state === "ready" || this.#state === "starting") {
			return;
		}
		this.#state = "starting";

		try {
			await this.refreshUsage();
		} catch (error) {
			this.#logger.debug("initial claude read failed", error);
		}

		this.#state = "ready";
		this.#startPolling();
		this.#emitHealth();
	}

	public async stop(): Promise<void> {
		this.#poll?.stop();
		this.#poll = undefined;
		this.#state = "stopped";
		if (this.#session !== undefined) {
			const disconnected: AgentSession = { ...this.#session, state: "disconnected", updatedAt: this.#now() };
			this.#session = disconnected;
			this.#emit({ type: "session-updated", session: disconnected });
		}
	}

	public async refreshUsage(): Promise<UsageSnapshot> {
		try {
			const reading = await this.#source.read();
			this.#windows = this.#parser.parse(reading.payload);
			this.#stale = reading.stale;
			this.#lastSuccessAt = reading.capturedAt;
			this.#lastError = undefined;

			const session = parseSession(reading.payload, this.id, reading.capturedAt);
			if (session !== undefined && !sameSession(this.#session, session)) {
				this.#session = session;
				this.#emit({ type: "session-updated", session });
			}
		} catch (error) {
			this.#lastError = toAgentDeckError(error);
			this.#logger.debug("claude status unavailable", {
				code: this.#lastError.code,
				message: this.#lastError.message,
			});
			// The snapshot is published either way — a degraded reading still has to
			// reach the deck — but the failure is rethrown so callers can react to
			// it rather than silently receiving a stale-looking success.
			const degraded = this.usageSnapshot();
			this.#emit({ type: "usage-updated", snapshot: degraded });
			throw this.#lastError;
		}

		const snapshot = this.usageSnapshot();
		this.#emit({ type: "usage-updated", snapshot });
		return snapshot;
	}

	public async listSessions(): Promise<AgentSession[]> {
		return this.#session === undefined ? [] : [this.#session];
	}

	public usageSnapshot(): UsageSnapshot {
		const snapshot: UsageSnapshot = {
			providerId: this.id,
			status: this.status,
			fetchedAt: this.#now(),
			windows: this.#windows,
		};
		if (this.#lastSuccessAt !== undefined) {
			snapshot.lastSuccessAt = this.#lastSuccessAt;
		}
		if (this.#lastError !== undefined && snapshot.status !== "ready") {
			snapshot.error = { code: this.#lastError.code, message: this.#lastError.message };
		}
		return snapshot;
	}

	/**
	 * Applies a changed global setting (design §17.4).
	 *
	 * Re-arms the timer in place rather than restarting: a Property Inspector
	 * edit arrives as several settings writes, and tearing the provider down for
	 * each would flash the Agent key OFFLINE and fire the git watcher every time.
	 */
	public configure(update: { refreshIntervalMs?: number }): void {
		const next = clampRefreshInterval(update.refreshIntervalMs);
		if (next === this.#refreshIntervalMs) {
			return;
		}
		this.#refreshIntervalMs = next;
		if (this.#poll !== undefined) {
			this.#startPolling();
		}
	}

	/** Effective interval after clamping; exposed so the floor can be asserted. */
	public get refreshIntervalMs(): number {
		return this.#refreshIntervalMs;
	}

	#startPolling(): void {
		this.#poll?.stop();
		this.#poll = scheduleInterval(
			this.#refreshIntervalMs,
			async () => {
				try {
					await this.refreshUsage();
				} catch (error) {
					this.#logger.debug("claude refresh failed", error);
				}
			},
			{ onError: (error) => this.#logger.debug("claude poll error", error) },
		);
	}

	#emitHealth(): void {
		this.#emit({ type: "provider-status", providerId: this.id, status: this.status });
		this.#emit({ type: "usage-updated", snapshot: this.usageSnapshot() });
	}

	#emit(event: ProviderEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				this.#logger.warn("provider event listener failed", error);
			}
		}
	}
}

/**
 * Compares every field the deck actually renders.
 *
 * Comparing only id/model meant a renamed session never reached the key, which
 * kept showing the old label until the model changed or the plugin restarted.
 */
function sameSession(a: AgentSession | undefined, b: AgentSession): boolean {
	return (
		a !== undefined && a.id === b.id && a.modelId === b.modelId && a.state === b.state && a.label === b.label
	);
}
