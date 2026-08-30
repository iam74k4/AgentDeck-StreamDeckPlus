/**
 * Codex provider — design §9, instructions §7.
 *
 * Owns the `codex app-server --stdio` process lifecycle, converts Codex
 * notifications into domain `ProviderEvent`s, and never lets a provider failure
 * escape as an unhandled rejection (instructions §7.5).
 *
 *   STOPPED → STARTING → INITIALIZING → READY
 *                                  ↘ BACKOFF → STARTING
 *                                  ↘ STOPPING → STOPPED
 */

import type { ModelDescriptor } from "../../domain/model.js";
import type { ProviderEvent, ProviderEventListener, Unsubscribe } from "../../domain/provider-events.js";
import type { AgentSession } from "../../domain/session.js";
import { AgentDeckError, toAgentDeckError } from "../../domain/errors.js";
import { providerStatusForError, type ProviderStatus, type UsageSnapshot } from "../../domain/usage.js";
import { Backoff } from "../../infrastructure/backoff.js";
import { resolveExecutable } from "../../infrastructure/executable.js";
import type { Logger } from "../../infrastructure/logger.js";
import { createLogger, nullSink } from "../../infrastructure/logger.js";
import { spawnManagedProcess, type ManagedProcess } from "../../infrastructure/process-manager.js";
import { scheduleInterval, type ScheduledTask } from "../../infrastructure/scheduler.js";
import type { AgentProvider, ProviderLifecycleState } from "../provider.js";
import { AppServerClient } from "./app-server-client.js";
import { JsonRpcTransport } from "./json-rpc.js";
import {
	applyFullRateLimits,
	applyRateLimitsUpdate,
	createRateLimitState,
	isRateLimitReached,
	threadStatusToSessionState,
	toUsageWindows,
	turnStatusToSessionState,
	wireModelToDescriptor,
	wireThreadToSession,
	type CodexRateLimitState,
} from "./mapper.js";
import {
	CodexNotification,
	type WireAccountRateLimitsUpdated,
	type WireThreadStartedNotification,
	type WireThreadStatusChanged,
	type WireTurnNotification,
} from "./protocol.js";

export const CODEX_PROVIDER_ID = "codex";

export interface CodexProviderOptions {
	/** Overridable per design §17.4 ("Executable override"). */
	executable?: string;
	args?: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	logger?: Logger;
	clientVersion?: string;
	/** Design §17.4 — Codex health check interval. */
	healthCheckIntervalMs?: number;
	/** Per-request timeout for app-server calls (design §27). */
	requestTimeoutMs?: number;
	/** Timeout for the `initialize` handshake specifically. */
	initializeTimeoutMs?: number;
	/** Test seam. */
	spawn?: typeof spawnManagedProcess;
	/** Test seam. */
	resolve?: typeof resolveExecutable;
	/** Set to false in tests to keep failures from rescheduling. */
	autoRestart?: boolean;
	backoff?: { initialDelayMs?: number; maxDelayMs?: number };
}

interface Connection {
	process: ManagedProcess;
	transport: JsonRpcTransport;
	client: AppServerClient;
	unsubscribe: () => void;
}

export class CodexProvider implements AgentProvider {
	public readonly id = CODEX_PROVIDER_ID;
	public readonly displayName = "Codex";

	#options: CodexProviderOptions;
	readonly #logger: Logger;
	readonly #listeners = new Set<ProviderEventListener>();
	readonly #sessions = new Map<string, AgentSession>();
	readonly #backoff: Backoff;
	readonly #spawn: typeof spawnManagedProcess;
	readonly #resolve: typeof resolveExecutable;

	#state: ProviderLifecycleState = "stopped";
	#connection: Connection | undefined;
	#rateLimits: CodexRateLimitState = createRateLimitState();
	#lastSuccessAt: Date | undefined;
	#lastError: AgentDeckError | undefined;
	#healthCheck: ScheduledTask | undefined;
	#restartTimer: NodeJS.Timeout | undefined;
	#startPromise: Promise<void> | undefined;
	#stopping = false;

	public constructor(options: CodexProviderOptions = {}) {
		this.#options = options;
		this.#logger = (options.logger ?? createLogger({ sink: nullSink })).child("codex");
		this.#backoff = new Backoff({
			initialDelayMs: options.backoff?.initialDelayMs ?? 2_000,
			maxDelayMs: options.backoff?.maxDelayMs ?? 60_000,
		});
		this.#spawn = options.spawn ?? spawnManagedProcess;
		this.#resolve = options.resolve ?? resolveExecutable;
	}

	/**
	 * Applies provider-level settings (design §17.4). Changing the executable or
	 * arguments restarts the app-server; other changes take effect on the next tick.
	 */
	public async configure(
		update: Pick<CodexProviderOptions, "executable" | "args" | "healthCheckIntervalMs">,
	): Promise<void> {
		const restartNeeded =
			(update.executable !== undefined && update.executable !== this.#options.executable) ||
			(update.args !== undefined && update.args.join(" ") !== (this.#options.args ?? []).join(" "));

		this.#options = {
			...this.#options,
			...(update.executable === undefined ? {} : { executable: update.executable }),
			...(update.args === undefined ? {} : { args: update.args }),
			...(update.healthCheckIntervalMs === undefined
				? {}
				: { healthCheckIntervalMs: update.healthCheckIntervalMs }),
		};

		if (restartNeeded && this.#state !== "stopped") {
			this.#logger.info("provider settings changed; restarting app-server");
			await this.stop();
			await this.start();
			return;
		}
		if (update.healthCheckIntervalMs !== undefined && this.#state === "ready") {
			this.#startHealthCheck();
		}
	}

	public get lifecycleState(): ProviderLifecycleState {
		return this.#state;
	}

	/**
	 * Design §17.3. Being connected is not the same as having usable data: a READY
	 * app-server whose last usage read failed still reports STALE or ERROR.
	 */
	public get status(): ProviderStatus {
		if (this.#state === "starting" || this.#state === "initializing") {
			return "loading";
		}
		const hasCache = this.#rateLimits.buckets.size > 0;
		if (this.#lastError !== undefined) {
			return providerStatusForError(this.#lastError.code, hasCache);
		}
		if (this.#state === "ready") {
			return isRateLimitReached(this.#rateLimits) ? "rate-limited" : "ready";
		}
		return hasCache ? "stale" : "error";
	}

	public subscribe(listener: ProviderEventListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public async isAvailable(): Promise<boolean> {
		return this.#resolve(this.#executable(), { env: this.#options.env }) !== undefined;
	}

	public start(): Promise<void> {
		this.#stopping = false;
		this.#startPromise ??= this.#startOnce().finally(() => {
			this.#startPromise = undefined;
		});
		return this.#startPromise;
	}

	public async stop(): Promise<void> {
		this.#stopping = true;
		this.#clearRestartTimer();
		this.#healthCheck?.stop();
		this.#healthCheck = undefined;

		const connection = this.#connection;
		if (connection === undefined) {
			this.#setState("stopped");
			return;
		}

		this.#setState("stopping");
		this.#connection = undefined;
		connection.unsubscribe();
		connection.transport.close(new AgentDeckError("INTERRUPTED", "Provider stopping."));
		await connection.process.shutdown();
		this.#markSessionsDisconnected();
		this.#setState("stopped");
	}

	public async refreshUsage(): Promise<UsageSnapshot> {
		const client = this.#requireClient();
		try {
			const response = await client.readRateLimits();
			this.#rateLimits = applyFullRateLimits(this.#rateLimits, response);
			this.#lastSuccessAt = new Date();
			this.#lastError = undefined;
			const snapshot = this.#usageSnapshot();
			this.#emit({ type: "usage-updated", snapshot });
			return snapshot;
		} catch (error) {
			this.#recordError(error);
			const snapshot = this.#usageSnapshot();
			this.#emit({ type: "usage-updated", snapshot });
			throw this.#lastError ?? toAgentDeckError(error);
		}
	}

	public async listSessions(): Promise<AgentSession[]> {
		const client = this.#requireClient();
		const response = await client.listThreads(20);
		const now = new Date();
		for (const thread of response.data ?? []) {
			if (thread === null || thread === undefined || typeof thread.id !== "string") {
				continue;
			}
			const mapped = wireThreadToSession(thread, this.id, now);
			this.#upsertSession(mapped, { emit: true });
		}
		return [...this.#sessions.values()];
	}

	/** Design §12.2 — STOP sends an interrupt for the session's in-flight turn. */
	public async interrupt(sessionId: string): Promise<void> {
		const client = this.#requireClient();
		const turnId = this.#sessions.get(sessionId)?.currentTurnId ?? (await this.#findActiveTurnId(sessionId));
		if (turnId === undefined) {
			throw new AgentDeckError("INTERRUPTED", "No in-flight turn to interrupt for this session.");
		}
		await client.interruptTurn(sessionId, turnId);
	}

	public async getModels(): Promise<ModelDescriptor[]> {
		const client = this.#requireClient();
		const response = await client.listModels();
		return (response.data ?? [])
			.filter((model): model is NonNullable<typeof model> => model !== null && model !== undefined)
			.map(wireModelToDescriptor);
	}

	public get sessions(): AgentSession[] {
		return [...this.#sessions.values()];
	}

	public usageSnapshot(): UsageSnapshot {
		return this.#usageSnapshot();
	}

	// ---------------------------------------------------------------- internals

	#executable(): string {
		return this.#options.executable ?? "codex";
	}

	async #startOnce(): Promise<void> {
		if (this.#state === "ready" || this.#state === "initializing" || this.#state === "starting") {
			return;
		}

		this.#setState("starting");
		const command = this.#executable();

		if (this.#resolve(command, { env: this.#options.env }) === undefined) {
			this.#recordError(new AgentDeckError("CLI_NOT_FOUND", `Codex CLI not found on PATH: ${command}`));
			this.#setState("stopped");
			this.#emitHealth();
			// A missing CLI is not retried on a timer; the user must install it.
			return;
		}

		let connection: Connection | undefined;
		try {
			connection = this.#connect(command);
			this.#connection = connection;
			this.#setState("initializing");

			await connection.client.initialize();
			this.#setState("ready");
			this.#backoff.reset();
			this.#lastError = undefined;

			await this.#primeState(connection);
			this.#startHealthCheck();
			this.#emitHealth();
		} catch (error) {
			this.#recordError(error);
			if (connection !== undefined) {
				connection.unsubscribe();
				connection.transport.close(this.#lastError);
				void connection.process.shutdown();
			}
			this.#connection = undefined;
			this.#emitHealth();
			this.#scheduleRestart();
		}
	}

	#connect(command: string): Connection {
		const child = this.#spawn({
			command,
			args: this.#options.args ?? ["app-server", "--stdio"],
			cwd: this.#options.cwd,
			env: this.#options.env,
			logger: this.#logger,
		});

		const transport = new JsonRpcTransport({
			input: child.stdout,
			output: child.stdin,
			logger: this.#logger,
			...(this.#options.requestTimeoutMs === undefined
				? {}
				: { requestTimeoutMs: this.#options.requestTimeoutMs }),
		});

		// Approvals are v0.4 (instructions §5); until then every server→client
		// request is declined rather than silently auto-approved (design §22.2).
		transport.setRequestHandler((request) => {
			this.#logger.info(`declining unsupported server request: ${request.method}`);
			throw new AgentDeckError("PROTOCOL_ERROR", `Unsupported: ${request.method}`);
		});

		const client = new AppServerClient({
			transport,
			clientInfo: {
				name: "agentdeck",
				title: "AgentDeck for Stream Deck Plus",
				version: this.#options.clientVersion ?? "0.0.1",
			},
			logger: this.#logger,
			...(this.#options.initializeTimeoutMs === undefined
				? {}
				: { initializeTimeoutMs: this.#options.initializeTimeoutMs }),
		});

		const unsubscribeNotifications = transport.onNotification((notification) => {
			this.#onNotification(notification.method, notification.params);
		});

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			const text = chunk.trim();
			if (text.length > 0) {
				this.#logger.debug("app-server stderr", text);
			}
		});

		void child.exited.then((exit) => {
			if (this.#connection?.process !== child) {
				return;
			}
			this.#logger.warn("app-server exited", exit);
			this.#connection = undefined;
			transport.close(new AgentDeckError("PROVIDER_OFFLINE", "App server exited."));
			this.#healthCheck?.stop();
			this.#healthCheck = undefined;
			this.#markSessionsDisconnected();
			if (!this.#stopping) {
				this.#recordError(new AgentDeckError("PROVIDER_OFFLINE", "App server exited."));
				this.#emitHealth();
				this.#scheduleRestart();
			}
		});

		return {
			process: child,
			transport,
			client,
			unsubscribe: unsubscribeNotifications,
		};
	}

	/** Initial reads once READY. Failures here degrade the snapshot, not the process. */
	async #primeState(connection: Connection): Promise<void> {
		try {
			const response = await connection.client.readRateLimits();
			this.#rateLimits = applyFullRateLimits(this.#rateLimits, response);
			this.#lastSuccessAt = new Date();
		} catch (error) {
			this.#recordError(error);
		}
		this.#emit({ type: "usage-updated", snapshot: this.#usageSnapshot() });

		try {
			await this.listSessions();
		} catch (error) {
			this.#logger.warn("thread/list failed during startup", error);
		}
	}

	#startHealthCheck(): void {
		this.#healthCheck?.stop();
		const interval = this.#options.healthCheckIntervalMs ?? 120_000;
		this.#healthCheck = scheduleInterval(
			interval,
			async () => {
				if (this.#state !== "ready") {
					return;
				}
				try {
					await this.refreshUsage();
				} catch (error) {
					this.#logger.debug("health check refresh failed", error);
				}
			},
			{ onError: (error) => this.#logger.debug("health check error", error) },
		);
	}

	#scheduleRestart(): void {
		if (this.#stopping || this.#options.autoRestart === false) {
			this.#setState("stopped");
			return;
		}
		this.#setState("backoff");
		const delayMs = this.#backoff.next();
		this.#logger.info(`restarting codex app-server in ${delayMs}ms`);
		this.#clearRestartTimer();
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = undefined;
			if (!this.#stopping) {
				void this.start();
			}
		}, delayMs);
		this.#restartTimer.unref?.();
	}

	#clearRestartTimer(): void {
		if (this.#restartTimer !== undefined) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = undefined;
		}
	}

	#onNotification(method: string, params: unknown): void {
		try {
			switch (method) {
				case CodexNotification.AccountRateLimitsUpdated:
					this.#onRateLimitsUpdated(params as WireAccountRateLimitsUpdated);
					return;
				case CodexNotification.ThreadStarted:
					this.#onThreadStarted(params as WireThreadStartedNotification);
					return;
				case CodexNotification.ThreadStatusChanged:
					this.#onThreadStatusChanged(params as WireThreadStatusChanged);
					return;
				case CodexNotification.TurnStarted:
					this.#onTurnStarted(params as WireTurnNotification);
					return;
				case CodexNotification.TurnCompleted:
					this.#onTurnCompleted(params as WireTurnNotification);
					return;
				case CodexNotification.ItemStarted:
				case CodexNotification.ItemCompleted:
					this.#touchSession((params as { threadId?: string } | undefined)?.threadId);
					return;
				default:
					this.#logger.debug(`unhandled notification: ${method}`);
			}
		} catch (error) {
			// A malformed notification must never kill the provider (instructions §7.5).
			this.#logger.warn(`failed to handle notification ${method}`, error);
		}
	}

	#onRateLimitsUpdated(params: WireAccountRateLimitsUpdated | undefined): void {
		if (params === undefined) {
			return;
		}
		// Design §9.4 — sparse merge, never a wholesale replace.
		this.#rateLimits = applyRateLimitsUpdate(this.#rateLimits, params);
		this.#lastSuccessAt = new Date();
		this.#lastError = undefined;
		this.#emit({ type: "usage-updated", snapshot: this.#usageSnapshot() });
	}

	#onThreadStarted(params: WireThreadStartedNotification | undefined): void {
		const thread = params?.thread;
		if (thread === null || thread === undefined || typeof thread.id !== "string") {
			return;
		}
		this.#upsertSession(wireThreadToSession(thread, this.id), { emit: true });
	}

	#onThreadStatusChanged(params: WireThreadStatusChanged | undefined): void {
		const threadId = params?.threadId;
		if (typeof threadId !== "string") {
			return;
		}
		const state = threadStatusToSessionState(params?.status);
		const existing = this.#sessions.get(threadId);
		const next: AgentSession = {
			...(existing ?? { id: threadId, providerId: this.id, state, updatedAt: new Date() }),
			state,
			updatedAt: new Date(),
		};
		if (state !== "working" && state !== "waiting-approval") {
			delete next.currentTurnId;
		}
		this.#upsertSession(next, { emit: true });
	}

	#onTurnStarted(params: WireTurnNotification | undefined): void {
		const threadId = params?.threadId;
		const turn = params?.turn;
		if (typeof threadId !== "string" || turn === null || turn === undefined) {
			return;
		}
		const existing = this.#sessions.get(threadId);
		const now = new Date();
		this.#upsertSession(
			{
				...(existing ?? { id: threadId, providerId: this.id, state: "working", updatedAt: now }),
				state: "working",
				currentTurnId: turn.id,
				startedAt: now,
				updatedAt: now,
			},
			{ emit: true },
		);
	}

	#onTurnCompleted(params: WireTurnNotification | undefined): void {
		const threadId = params?.threadId;
		const turn = params?.turn;
		if (typeof threadId !== "string") {
			return;
		}
		const existing = this.#sessions.get(threadId);
		const now = new Date();
		const next: AgentSession = {
			...(existing ?? { id: threadId, providerId: this.id, state: "completed", updatedAt: now }),
			state: turnStatusToSessionState(turn?.status ?? "completed"),
			updatedAt: now,
		};
		delete next.currentTurnId;
		const usage = turn?.tokenUsage;
		if (usage !== null && usage !== undefined) {
			next.tokenUsage = {
				...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
				...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
			};
		}
		this.#upsertSession(next, { emit: true });
	}

	#touchSession(threadId: string | undefined): void {
		if (typeof threadId !== "string") {
			return;
		}
		const existing = this.#sessions.get(threadId);
		if (existing === undefined) {
			return;
		}
		this.#upsertSession({ ...existing, updatedAt: new Date() }, { emit: true });
	}

	async #findActiveTurnId(sessionId: string): Promise<string | undefined> {
		try {
			const response = await this.#requireClient().readThread(sessionId, true);
			const turns = response.thread?.turns ?? [];
			for (let index = turns.length - 1; index >= 0; index -= 1) {
				const turn = turns[index];
				if (turn?.status === "inProgress") {
					return turn.id;
				}
			}
		} catch (error) {
			this.#logger.debug("thread/read failed while looking for an active turn", error);
		}
		return undefined;
	}

	#upsertSession(session: AgentSession, options: { emit: boolean }): void {
		this.#sessions.set(session.id, session);
		if (options.emit) {
			this.#emit({ type: "session-updated", session });
		}
	}

	#markSessionsDisconnected(): void {
		const now = new Date();
		for (const [id, session] of this.#sessions) {
			if (session.state === "disconnected") {
				continue;
			}
			const next: AgentSession = { ...session, state: "disconnected", updatedAt: now };
			delete next.currentTurnId;
			this.#sessions.set(id, next);
			this.#emit({ type: "session-updated", session: next });
		}
	}

	#requireClient(): AppServerClient {
		const client = this.#connection?.client;
		if (client === undefined || !client.initialized) {
			throw new AgentDeckError("PROVIDER_OFFLINE", "Codex app-server is not connected.");
		}
		return client;
	}

	#usageSnapshot(): UsageSnapshot {
		const snapshot: UsageSnapshot = {
			providerId: this.id,
			status: this.status,
			fetchedAt: new Date(),
			windows: toUsageWindows(this.#rateLimits),
		};
		if (this.#lastSuccessAt !== undefined) {
			snapshot.lastSuccessAt = this.#lastSuccessAt;
		}
		if (this.#lastError !== undefined && snapshot.status !== "ready") {
			snapshot.error = { code: this.#lastError.code, message: this.#lastError.message };
		}
		return snapshot;
	}

	#recordError(error: unknown): void {
		this.#lastError = toAgentDeckError(error);
		this.#logger.warn("codex provider error", {
			code: this.#lastError.code,
			message: this.#lastError.message,
		});
	}

	#setState(state: ProviderLifecycleState): void {
		if (this.#state === state) {
			return;
		}
		this.#state = state;
		this.#logger.debug(`lifecycle → ${state}`);
	}

	/**
	 * Health changes are also usage changes: the shared usage cache is what the keys
	 * and the touch strip read, so a CLI_NOT_FOUND or a crash has to reach it too —
	 * otherwise the deck keeps showing a stale READY reading (design §17.1, §17.3).
	 */
	#emitHealth(): void {
		this.#emit({ type: "provider-status", providerId: this.id, status: this.status });
		this.#emit({ type: "usage-updated", snapshot: this.#usageSnapshot() });
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
