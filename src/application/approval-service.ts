/**
 * Approval service — design §12.4, §22.2.
 *
 * Holds the approval requests providers are waiting on and routes the user's
 * answer back to the provider that asked. It never decides anything itself:
 * there is no auto-approve, no auto-deny, and no timer that answers on the
 * user's behalf (instructions §2.5).
 *
 * Requests are queued oldest-first, so the Approve / Deny keys always act on the
 * request the deck is showing.
 */

import type { ApprovalDecision, ApprovalRequest } from "../domain/approval.js";
import { AgentDeckError } from "../domain/errors.js";
import type { Unsubscribe } from "../domain/provider-events.js";
import type { ProviderId } from "../domain/usage.js";
import type { Logger } from "../infrastructure/logger.js";
import type { ProviderRegistry } from "./provider-registry.js";

/** A request plus the provider that must be answered. */
export interface PendingApproval {
	providerId: ProviderId;
	request: ApprovalRequest;
}

export type ApprovalListener = (pending: readonly PendingApproval[]) => void;

export interface ApprovalServiceOptions {
	logger?: Logger;
}

export class ApprovalService {
	readonly #registry: ProviderRegistry;
	readonly #logger: Logger | undefined;
	readonly #listeners = new Set<ApprovalListener>();
	/** Insertion order is the queue order. */
	readonly #pending = new Map<string, PendingApproval>();
	#unsubscribe: Unsubscribe | undefined;

	public constructor(registry: ProviderRegistry, options: ApprovalServiceOptions = {}) {
		this.#registry = registry;
		this.#logger = options.logger?.child("approval");

		this.#unsubscribe = registry.subscribe((event, providerId) => {
			if (event.type === "approval-requested") {
				this.#pending.set(this.#key(providerId, event.request.id), { providerId, request: event.request });
				this.#logger?.info(`approval requested: ${event.request.type} (${event.request.risk} risk)`);
				this.#notify();
				return;
			}
			if (event.type === "approval-resolved") {
				// Keyed by provider: approval ids are only unique within one.
				if (this.#pending.delete(this.#key(providerId, event.approvalId))) {
					this.#notify();
				}
			}
		});
	}

	public subscribe(listener: ApprovalListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public list(providerId?: ProviderId): PendingApproval[] {
		const all = [...this.#pending.values()];
		return providerId === undefined ? all : all.filter((entry) => entry.providerId === providerId);
	}

	public get count(): number {
		return this.#pending.size;
	}

	/** The request the Approve / Deny keys act on: the one that has waited longest. */
	public current(providerId?: ProviderId): PendingApproval | undefined {
		for (const entry of this.#pending.values()) {
			if (providerId === undefined || entry.providerId === providerId) {
				return entry;
			}
		}
		return undefined;
	}

	/** Answers whichever request the deck is currently showing. */
	public async resolveCurrent(decision: ApprovalDecision, providerId?: ProviderId): Promise<void> {
		const entry = this.current(providerId);
		if (entry === undefined) {
			throw new AgentDeckError("PROTOCOL_ERROR", "There is no approval request waiting.");
		}
		await this.resolve(entry.request.id, decision);
	}

	public async resolve(approvalId: string, decision: ApprovalDecision): Promise<void> {
		const entry = this.list().find((candidate) => candidate.request.id === approvalId);
		if (entry === undefined) {
			throw new AgentDeckError("PROTOCOL_ERROR", "That approval request is no longer waiting.");
		}
		const provider = this.#registry.get(entry.providerId);
		if (provider?.resolveApproval === undefined) {
			throw new AgentDeckError("PROTOCOL_ERROR", `Provider ${entry.providerId} cannot answer approvals.`);
		}

		await provider.resolveApproval(approvalId, decision);
		// The provider also emits `approval-resolved`; dropping it here as well
		// keeps a second press from acting on a request already answered.
		if (this.#pending.delete(this.#key(entry.providerId, approvalId))) {
			this.#notify();
		}
	}

	public dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#listeners.clear();
		this.#pending.clear();
	}

	/**
	 * Approval ids are only unique per provider, and the domain `ApprovalRequest`
	 * carries no provider (design §12.4), so provenance is recorded here rather
	 * than by widening the domain type.
	 */
	#key(providerId: ProviderId, approvalId: string): string {
		return `${providerId}::${approvalId}`;
	}

	#notify(): void {
		const snapshot = this.list();
		for (const listener of this.#listeners) {
			try {
				listener(snapshot);
			} catch (error) {
				this.#logger?.warn("approval listener failed", error);
			}
		}
	}
}
