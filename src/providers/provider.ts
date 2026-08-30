/**
 * Provider contract — design §8.1.
 *
 * `ProviderId` is a plain string on purpose: providers register themselves, and
 * adding one must not require editing a union type anywhere else.
 */

import type { ModelDescriptor } from "../domain/model.js";
import type { ProviderEventListener, Unsubscribe } from "../domain/provider-events.js";
import type { AgentSession } from "../domain/session.js";
import type { ProviderId, UsageSnapshot } from "../domain/usage.js";

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
	steer?(sessionId: string, text: string): Promise<void>;
	getModels?(): Promise<ModelDescriptor[]>;

	subscribe(listener: ProviderEventListener): Unsubscribe;
}
