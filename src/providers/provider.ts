/**
 * Provider contract — design §8.1.
 *
 * `ProviderId` is a plain string on purpose: providers register themselves, and
 * adding one must not require editing a union type anywhere else.
 */

import type { ApprovalDecision } from "../domain/approval.js";
import type { ModelDescriptor, ModelSelection } from "../domain/model.js";
import type { ProviderEventListener, Unsubscribe } from "../domain/provider-events.js";
import type { AgentSession } from "../domain/session.js";
import type { ProviderId, UsageSnapshot } from "../domain/usage.js";

/**
 * What the deck can hand to an agent.
 *
 * Text comes from a prompt preset, the clipboard or dictation; images from a
 * screenshot. Both are user-initiated: nothing here is ever sent automatically
 * (design §22.4).
 */
export interface AgentInput {
	text?: string;
	/** Absolute paths to local images. */
	imagePaths?: readonly string[];
}

/** Design §9.5 — the provider process lifecycle. */
export type ProviderLifecycleState =
	"stopped" | "starting" | "initializing" | "ready" | "backoff" | "stopping";

export interface AgentProvider {
	readonly id: ProviderId;
	readonly displayName: string;

	isAvailable(): Promise<boolean>;
	start(): Promise<void>;
	stop(): Promise<void>;

	/**
	 * Pull path for usage, complementing the push path in design §17.1. Providers
	 * that only ever push omit it and the service relies on `usage-updated`.
	 */
	refreshUsage?(): Promise<UsageSnapshot>;

	listSessions?(): Promise<AgentSession[]>;
	interrupt?(sessionId: string): Promise<void>;

	/**
	 * Sends input to a session (design §12.3).
	 *
	 * Widened from the design's `steer(sessionId, text)` because Screenshot → AI
	 * (§15.1) has to attach an image, and one method that carries what the deck
	 * captured reads better than a second one beside it. Text-only callers pass
	 * `{ text }`.
	 */
	steer?(sessionId: string, input: AgentInput): Promise<void>;

	/** Opens a new session, optionally rooted at a directory (design §14 target). */
	startSession?(options?: { cwd?: string }): Promise<AgentSession>;
	getModels?(): Promise<ModelDescriptor[]>;

	/**
	 * Applies a model / reasoning choice to a session (design §19).
	 *
	 * Absent when the provider has no control channel, which is how the selector
	 * knows to render itself disabled rather than failing on press.
	 */
	applyModel?(sessionId: string, selection: ModelSelection): Promise<void>;

	/**
	 * Answers a request this provider raised (design §12.4).
	 *
	 * The decision type has two values and no third; a provider cannot be asked
	 * for a session-wide or persisted approval because no such value exists.
	 */
	resolveApproval?(approvalId: string, decision: ApprovalDecision): Promise<void>;

	subscribe(listener: ProviderEventListener): Unsubscribe;
}
