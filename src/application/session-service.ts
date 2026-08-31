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
				if (removed !== undefined && this.#pinnedSessionId === event.sessionId) {
					this.#pinnedSessionId = undefined;
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
