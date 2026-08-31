/**
 * The approval queue and the wire dialect it produces.
 *
 * The safety property under test is stated in instructions §2.5: AgentDeck has
 * Approve Once and Deny. Nothing here may produce a value that grants approval
 * beyond the single request being answered.
 */

import { describe, expect, it, vi } from "vitest";
import { ApprovalService } from "@/application/approval-service.js";
import { ProviderRegistry } from "@/application/provider-registry.js";
import type { ApprovalDecision, ApprovalRequest } from "@/domain/approval.js";
import type { ProviderEvent, ProviderEventListener, Unsubscribe } from "@/domain/provider-events.js";
import type { AgentProvider } from "@/providers/provider.js";
import {
	CodexApprovalMethod,
	parseApprovalRequest,
	toApprovalDecision,
	toApprovalResponse,
	toReviewDecision,
} from "@/providers/codex/approval-mapper.js";

class ApprovingProvider implements AgentProvider {
	public readonly answered: { id: string; decision: ApprovalDecision }[] = [];
	readonly #listeners = new Set<ProviderEventListener>();

	public constructor(
		public readonly id: string,
		public readonly displayName = id,
	) {}

	public async isAvailable(): Promise<boolean> {
		return true;
	}
	public async start(): Promise<void> {}
	public async stop(): Promise<void> {}
	public subscribe(listener: ProviderEventListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	public async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
		this.answered.push({ id: approvalId, decision });
		this.emit({ type: "approval-resolved", approvalId });
	}
	public emit(event: ProviderEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}
}

/** A provider with no control channel, e.g. Claude (design §10). */
class MonitoringProvider implements AgentProvider {
	readonly #listeners = new Set<ProviderEventListener>();
	public constructor(public readonly id: string) {}
	public readonly displayName = "Monitoring";
	public async isAvailable(): Promise<boolean> {
		return true;
	}
	public async start(): Promise<void> {}
	public async stop(): Promise<void> {}
	public subscribe(listener: ProviderEventListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	public emit(event: ProviderEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		id: "req_1",
		sessionId: "thr_1",
		type: "command",
		title: "npm test",
		summary: "",
		risk: "low",
		...overrides,
	};
}

function setup(): { service: ApprovalService; provider: ApprovingProvider; registry: ProviderRegistry } {
	const registry = new ProviderRegistry();
	const provider = new ApprovingProvider("codex");
	registry.register(provider);
	return { service: new ApprovalService(registry), provider, registry };
}

describe("ApprovalService", () => {
	it("queues requests oldest first", () => {
		const { service, provider } = setup();
		provider.emit({ type: "approval-requested", request: request({ id: "a" }) });
		provider.emit({ type: "approval-requested", request: request({ id: "b" }) });

		expect(service.count).toBe(2);
		expect(service.current()?.request.id).toBe("a");
	});

	it("routes the answer to the provider that asked", async () => {
		const { service, provider } = setup();
		provider.emit({ type: "approval-requested", request: request({ id: "a" }) });

		await service.resolveCurrent("approve-once");

		expect(provider.answered).toEqual([{ id: "a", decision: "approve-once" }]);
		expect(service.count).toBe(0);
	});

	it("does not act twice on a request that was already answered", async () => {
		const { service, provider } = setup();
		provider.emit({ type: "approval-requested", request: request({ id: "a" }) });

		await service.resolveCurrent("deny");
		await expect(service.resolve("a", "approve-once")).rejects.toThrow();
		expect(provider.answered).toEqual([{ id: "a", decision: "deny" }]);
	});

	it("keeps two providers' identically numbered requests apart", async () => {
		const registry = new ProviderRegistry();
		const codex = new ApprovingProvider("codex");
		const other = new ApprovingProvider("other");
		registry.register(codex);
		registry.register(other);
		const service = new ApprovalService(registry);

		codex.emit({ type: "approval-requested", request: request({ id: "1" }) });
		other.emit({ type: "approval-requested", request: request({ id: "1" }) });
		expect(service.count).toBe(2);

		// Resolving one provider's request must not clear the other's.
		other.emit({ type: "approval-resolved", approvalId: "1" });
		expect(service.list().map((entry) => entry.providerId)).toEqual(["codex"]);
	});

	it("refuses to answer for a provider that has no approval channel", async () => {
		const registry = new ProviderRegistry();
		const provider = new MonitoringProvider("claude");
		registry.register(provider);
		const service = new ApprovalService(registry);
		provider.emit({ type: "approval-requested", request: request({ id: "a" }) });

		await expect(service.resolveCurrent("approve-once")).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
	});

	it("reports having nothing to answer rather than answering nothing", async () => {
		const { service } = setup();
		await expect(service.resolveCurrent("deny")).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
	});

	it("notifies subscribers as the queue changes", () => {
		const { service, provider } = setup();
		const listener = vi.fn();
		service.subscribe(listener);

		provider.emit({ type: "approval-requested", request: request({ id: "a" }) });
		provider.emit({ type: "approval-resolved", approvalId: "a" });

		expect(listener).toHaveBeenCalledTimes(2);
		expect(listener).toHaveBeenLastCalledWith([]);
	});
});

describe("the decision that reaches the wire", () => {
	/**
	 * Every value Codex would read as a blanket approval. None may be reachable
	 * from any decision AgentDeck can hold.
	 */
	const FORBIDDEN = [
		"acceptForSession",
		"acceptWithExecpolicyAmendment",
		"applyNetworkPolicyAmendment",
		"cancel",
		"approved_for_session",
		"approved_execpolicy_amendment",
		"approved_mcp_policy_amendment",
		"network_policy_amendment",
	];

	const DECISIONS: ApprovalDecision[] = ["approve-once", "deny"];
	const METHODS = Object.values(CodexApprovalMethod);

	it("only ever emits accept / decline on the modern surface", () => {
		expect(DECISIONS.map(toApprovalDecision)).toEqual(["accept", "decline"]);
	});

	it("only ever emits approved / denied on the legacy surface", () => {
		expect(toReviewDecision("approve-once")).toBe("approved");
		expect(toReviewDecision("deny")).toEqual({ denied: { rejection: "Denied from AgentDeck" } });
	});

	it("cannot produce a persistent approval on any surface, from any decision", () => {
		for (const method of METHODS) {
			for (const decision of DECISIONS) {
				const serialised = JSON.stringify(toApprovalResponse(method, decision));
				for (const forbidden of FORBIDDEN) {
					expect(serialised).not.toContain(forbidden);
				}
			}
		}
	});
});

describe("parseApprovalRequest", () => {
	const options = { requestId: "7", projectPath: "C:/work/Game" };

	it("reads a modern command approval", () => {
		expect(
			parseApprovalRequest(
				CodexApprovalMethod.CommandExecution,
				{ threadId: "thr_1", turnId: "t", itemId: "i", startedAtMs: 1, command: "rm -rf dist" },
				options,
			),
		).toMatchObject({ id: "7", sessionId: "thr_1", type: "command", risk: "high" });
	});

	it("reads a legacy command approval", () => {
		expect(
			parseApprovalRequest(
				CodexApprovalMethod.ExecCommand,
				{ conversationId: "thr_1", callId: "c", command: ["git", "status"], cwd: "C:/work/Game" },
				options,
			),
		).toMatchObject({ sessionId: "thr_1", title: "git status", risk: "low" });
	});

	it("reads a legacy patch approval and names the files", () => {
		expect(
			parseApprovalRequest(
				CodexApprovalMethod.ApplyPatch,
				{ conversationId: "thr_1", callId: "c", fileChanges: { "C:/work/Game/src/a.ts": {} } },
				options,
			),
		).toMatchObject({ type: "file-change", title: "C:/work/Game/src/a.ts", risk: "low" });
	});

	it("returns nothing for a request it cannot describe", () => {
		expect(parseApprovalRequest("item/tool/call", { threadId: "thr_1" }, options)).toBeUndefined();
		expect(parseApprovalRequest(CodexApprovalMethod.CommandExecution, undefined, options)).toBeUndefined();
		expect(parseApprovalRequest(CodexApprovalMethod.CommandExecution, {}, options)).toBeUndefined();
		expect(
			parseApprovalRequest(CodexApprovalMethod.ExecCommand, { conversationId: "t", command: [] }, options),
		).toBeUndefined();
	});
});
