/**
 * Session service — design §7.2, instructions §9.
 *
 * Holds agent sessions for every provider and tracks which one the "active
 * session" actions follow. Sessions are kept separate from projects on purpose
 * (design §3.4); a project binding is attached, never conflated.
 */

import type { Unsubscribe } from "../domain/provider-events.js";
import { AgentDeckError } from "../domain/errors.js";
import { isInterruptible, pickActiveSession, type AgentSession } from "../domain/session.js";
import type { ProviderId } from "../domain/usage.js";
import type { Logger } from "../infrastructure/logger.js";
import type { AgentInput, AgentProvider } from "../providers/provider.js";
import type { ProviderRegistry } from "./provider-registry.js";

export type SessionListener = (sessions: readonly AgentSession[]) => void;

export interface SessionServiceOptions {
	logger?: Logger;
}

export class SessionService {
	readonly #registry: ProviderRegistry;
	readonly #sessions = new Map<string, AgentSession>();
	readonly #listeners = new Set<SessionListener>();
	readonly #logger: Logger | undefined;
	#pinnedSessionId: string | undefined;
	#highlightedSessionId: string | undefined;
	#unsubscribe: Unsubscribe | undefined;

	public constructor(registry: ProviderRegistry, options: SessionServiceOptions = {}) {
		this.#registry = registry;
		this.#logger = options.logger?.child("session");

		this.#unsubscribe = registry.subscribe((event, providerId) => {
			if (event.type === "session-updated") {
				this.#sessions.set(this.#key(event.session), event.session);
				this.#notify();
				return;
			}
			if (event.type === "session-removed") {
				// Session ids are only unique per provider, so remove the exact one
				// rather than every session that happens to share the id.
				const key = `${providerId}::${event.sessionId}`;
				const removed = this.#sessions.get(key);
				this.#sessions.delete(key);
				if (removed !== undefined) {
					if (this.#pinnedSessionId === event.sessionId) {
						this.#pinnedSessionId = undefined;
					}
					if (this.#highlightedSessionId === event.sessionId) {
						this.#highlightedSessionId = undefined;
					}
				}
				this.#notify();
			}
		});
	}

	public subscribe(listener: SessionListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public list(providerId?: ProviderId): AgentSession[] {
		const all = [...this.#sessions.values()];
		return providerId === undefined ? all : all.filter((session) => session.providerId === providerId);
	}

	/**
	 * The session an "active session" action follows: an explicit pin when the
	 * user set one, otherwise the busiest / most recently updated session.
	 */
	public getActiveSession(providerId?: ProviderId): AgentSession | undefined {
		const candidates = this.list(providerId);
		if (this.#pinnedSessionId !== undefined) {
			const pinned = candidates.find((session) => session.id === this.#pinnedSessionId);
			if (pinned !== undefined) {
				return pinned;
			}
			// Design §7.5 applies the same way here: a pin that disappears is not
			// silently replaced, but the active-session view still needs a value.
			this.#logger?.debug("pinned session is gone; falling back to auto selection");
		}
		return pickActiveSession(candidates);
	}

	public pin(sessionId: string | undefined): void {
		this.#pinnedSessionId = sessionId;
		this.#notify();
	}

	/**
	 * The session the Session dial is pointing at — design §6.1 dial 2.
	 *
	 * Rotating moves this; only a press pins it. The two are separate for the same
	 * reason the model selector separates them: a dial nudged while reaching past
	 * the deck must not silently redirect the keys that follow the active session.
	 *
	 * Defaults to whatever is active, so the first rotation starts from what the
	 * deck is already showing rather than from the top of the list.
	 */
	public getHighlighted(providerId?: ProviderId): AgentSession | undefined {
		const candidates = this.list(providerId);
		const highlighted = candidates.find((session) => session.id === this.#highlightedSessionId);
		return highlighted ?? this.getActiveSession(providerId);
	}

	/**
	 * The sessions in the order the dial steps through them.
	 *
	 * Public because the segment shows a position — `2/3` — and reading that from
	 * the unordered list made the number jump around as the dial moved.
	 */
	public ordered(providerId?: ProviderId): AgentSession[] {
		return this.list(providerId).sort((left, right) => left.id.localeCompare(right.id));
	}

	public rotateHighlight(providerId: ProviderId | undefined, delta: number): void {
		const candidates = this.ordered(providerId);
		if (candidates.length === 0) {
			return;
		}
		const current = this.getHighlighted(providerId);
		const index = candidates.findIndex((session) => session.id === current?.id);
		const from = index === -1 ? 0 : index;
		const next = candidates[(((from + delta) % candidates.length) + candidates.length) % candidates.length];
		this.#highlightedSessionId = next?.id;
		this.#notify();
	}

	/** Design §6.1 dial 2, press — "Active Session選択". */
	public pinHighlighted(providerId?: ProviderId): AgentSession | undefined {
		const highlighted = this.getHighlighted(providerId);
		if (highlighted === undefined) {
			return undefined;
		}
		// Pressing the session already pinned releases the pin, so there is a way
		// back to following whatever is busiest without a settings trip.
		this.#pinnedSessionId = this.#pinnedSessionId === highlighted.id ? undefined : highlighted.id;
		this.#notify();
		return highlighted;
	}

	public get pinnedSessionId(): string | undefined {
		return this.#pinnedSessionId;
	}

	/** Refreshes the session list from every provider that can list sessions. */
	public async refresh(): Promise<AgentSession[]> {
		await Promise.all(
			this.#registry.list().map(async (provider) => {
				if (provider.listSessions === undefined) {
					return;
				}
				try {
					const sessions = await provider.listSessions();
					for (const session of sessions) {
						this.#sessions.set(this.#key(session), session);
					}
				} catch (error) {
					this.#logger?.debug(`listSessions failed for ${provider.id}`, error);
				}
			}),
		);
		this.#notify();
		return this.list();
	}

	/** Design §12.2 — STOP targets the active session's in-flight turn. */
	public async interruptActive(providerId?: ProviderId): Promise<void> {
		const session = this.getActiveSession(providerId);
		if (!isInterruptible(session)) {
			throw new AgentDeckError("INTERRUPTED", "No running agent turn to stop.");
		}
		const provider = this.#registry.get(session.providerId);
		if (provider?.interrupt === undefined) {
			throw new AgentDeckError("PROTOCOL_ERROR", `Provider ${session.providerId} cannot interrupt.`);
		}
		await provider.interrupt(session.id);
	}

	/**
	 * Design §12.3 — sends input to the session the deck is following.
	 *
	 * With no session to send to, this opens one only when the caller asked for
	 * it: a Prompt key set to "active session" should report that there is none
	 * rather than quietly starting a conversation the user did not ask for.
	 */
	public async send(
		input: AgentInput,
		options: { providerId?: ProviderId; target?: "active-session" | "new-session"; cwd?: string } = {},
	): Promise<AgentSession> {
		const providerId = options.providerId;
		const provider = providerId === undefined ? undefined : this.#registry.get(providerId);
		if (provider === undefined || provider.steer === undefined) {
			throw new AgentDeckError("PROTOCOL_ERROR", `Provider ${providerId ?? "(none)"} cannot be sent input.`);
		}

		const session =
			options.target === "new-session"
				? await this.#startSession(provider, options.cwd)
				: (this.getActiveSession(providerId) ?? (await this.#startSession(provider, options.cwd)));

		await provider.steer(session.id, input);
		return session;
	}

	async #startSession(provider: AgentProvider, cwd: string | undefined): Promise<AgentSession> {
		if (provider.startSession === undefined) {
			throw new AgentDeckError("PROTOCOL_ERROR", `Provider ${provider.id} cannot start a session.`);
		}
		const session = await provider.startSession(cwd === undefined ? {} : { cwd });
		this.#sessions.set(this.#key(session), session);
		this.#notify();
		return session;
	}

	public dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#listeners.clear();
		this.#sessions.clear();
	}

	/** Session ids are only unique per provider. */
	#key(session: AgentSession): string {
		return `${session.providerId}::${session.id}`;
	}

	#notify(): void {
		const snapshot = this.list();
		for (const listener of this.#listeners) {
			try {
				listener(snapshot);
			} catch (error) {
				this.#logger?.warn("session listener failed", error);
			}
		}
	}
}
