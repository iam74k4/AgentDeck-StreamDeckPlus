/**
 * Codex approval requests → domain, and domain decisions → the wire.
 *
 * This is the only module allowed to produce a Codex decision value, and that is
 * the point. Both of Codex's approval surfaces offer variants that grant
 * approval beyond the single request being answered:
 *
 *   modern (v2)   acceptForSession, acceptWithExecpolicyAmendment,
 *                 applyNetworkPolicyAmendment
 *   legacy (v1)   approved_for_session, approved_execpolicy_amendment,
 *                 approved_mcp_policy_amendment, network_policy_amendment
 *
 * Instructions §2.5 and design §22.2 forbid all of them: AgentDeck has Approve
 * Once and Deny, and nothing else. Every function here takes the two-value
 * {@link ApprovalDecision}, so the forbidden values are unreachable rather than
 * merely unused.
 *
 * Two surfaces exist because Codex routes approvals differently depending on how
 * the turn was started (openai/codex `server_request_definitions!`):
 *
 *   item/commandExecution/requestApproval  turns started via `turn/start`
 *   item/fileChange/requestApproval        turns started via `turn/start`
 *   execCommandApproval                    legacy `sendUserTurn`/`sendUserMessage`
 *   applyPatchApproval                     legacy `sendUserTurn`/`sendUserMessage`
 *
 * The modern pair is what a client on the current API receives; the legacy pair
 * is answered too, because a server can still send it and an unanswered approval
 * leaves the agent waiting forever.
 */

import { assessRisk, type ApprovalDecision, type ApprovalRequest } from "../../domain/approval.js";

export const CodexApprovalMethod = {
	CommandExecution: "item/commandExecution/requestApproval",
	FileChange: "item/fileChange/requestApproval",
	/** Legacy surface. */
	ExecCommand: "execCommandApproval",
	/** Legacy surface. */
	ApplyPatch: "applyPatchApproval",
} as const;

const APPROVAL_METHODS: ReadonlySet<string> = new Set(Object.values(CodexApprovalMethod));

export function isApprovalMethod(method: string): boolean {
	return APPROVAL_METHODS.has(method);
}

/** `CommandExecutionRequestApprovalParams` — the command arrives pre-joined here. */
export interface WireCommandExecutionApprovalParams {
	kind?: string;
	threadId?: string;
	turnId?: string;
	itemId?: string;
	approvalId?: string | null;
	command?: string | null;
	cwd?: string | null;
	reason?: string | null;
}

/** `FileChangeRequestApprovalParams` — identifies the change by item, not by path. */
export interface WireFileChangeApprovalParams {
	threadId?: string;
	turnId?: string;
	itemId?: string;
	reason?: string | null;
	grantRoot?: string | null;
}

export interface WireExecCommandApprovalParams {
	conversationId?: string;
	callId?: string;
	approvalId?: string | null;
	command?: string[];
	cwd?: string;
	reason?: string | null;
}

export interface WireApplyPatchApprovalParams {
	conversationId?: string;
	callId?: string;
	fileChanges?: Record<string, unknown>;
	reason?: string | null;
	grantRoot?: string | null;
}

/** The only decision values AgentDeck can put on the modern surface. */
export type WireApprovalDecision = "accept" | "decline";
/** The only decision values AgentDeck can put on the legacy surface. */
export type WireReviewDecision = "approved" | { denied: { rejection: string } };

const DEFAULT_REJECTION = "Denied from AgentDeck";

/**
 * Maps the two-value domain decision onto the modern surface.
 *
 * `decline` rather than `cancel`: Deny refuses this one action and lets the agent
 * carry on, which is what a single Deny key should mean. Cancelling the whole
 * turn is what the STOP key is for (design §12.2).
 */
export function toApprovalDecision(decision: ApprovalDecision): WireApprovalDecision {
	return decision === "approve-once" ? "accept" : "decline";
}

/** Maps the two-value domain decision onto the legacy surface. */
export function toReviewDecision(
	decision: ApprovalDecision,
	rejection = DEFAULT_REJECTION,
): WireReviewDecision {
	return decision === "approve-once" ? "approved" : { denied: { rejection } };
}

/**
 * Builds the JSON-RPC result for an approval request.
 *
 * Both surfaces answer with `{ decision }`; only the dialect of the value
 * differs, so the method the request arrived on decides which one is spoken.
 */
export function toApprovalResponse(
	method: string,
	decision: ApprovalDecision,
	rejection = DEFAULT_REJECTION,
): { decision: WireApprovalDecision | WireReviewDecision } {
	if (method === CodexApprovalMethod.ExecCommand || method === CodexApprovalMethod.ApplyPatch) {
		return { decision: toReviewDecision(decision, rejection) };
	}
	return { decision: toApprovalDecision(decision) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function truncate(value: string, limit = 120): string {
	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Builds the domain request from a Codex approval.
 *
 * Returns `undefined` for anything unrecognisable: a request the deck cannot
 * describe is one the user cannot judge, so it is left to Codex's own UI rather
 * than shown as a mystery prompt with an Approve key under it.
 */
export function parseApprovalRequest(
	method: string,
	params: unknown,
	options: { requestId: string; projectPath?: string },
): ApprovalRequest | undefined {
	if (!isRecord(params)) {
		return undefined;
	}
	const projectPath = options.projectPath;

	switch (method) {
		case CodexApprovalMethod.CommandExecution: {
			const wire = params as WireCommandExecutionApprovalParams;
			const sessionId = optionalString(wire.threadId);
			if (sessionId === undefined) {
				return undefined;
			}
			const commandLine = optionalString(wire.command);
			const cwd = optionalString(wire.cwd);
			return {
				id: options.requestId,
				sessionId,
				type: "command",
				title: truncate(commandLine ?? "Command"),
				summary: optionalString(wire.reason) ?? cwd ?? "",
				risk: assessRisk({
					type: "command",
					...(commandLine === undefined ? {} : { commandLine }),
					...(cwd === undefined ? {} : { cwd }),
					...(projectPath === undefined ? {} : { projectPath }),
				}),
			};
		}

		case CodexApprovalMethod.FileChange: {
			const wire = params as WireFileChangeApprovalParams;
			const sessionId = optionalString(wire.threadId);
			if (sessionId === undefined) {
				return undefined;
			}
			// This surface names the change by item id; the paths are not in the
			// request, so `assessRisk` sees an empty path list and asks for a hold.
			return {
				id: options.requestId,
				sessionId,
				type: "file-change",
				title: "File change",
				summary: optionalString(wire.reason) ?? optionalString(wire.grantRoot) ?? "",
				risk: assessRisk({
					type: "file-change",
					paths: [],
					...(projectPath === undefined ? {} : { projectPath }),
				}),
			};
		}

		case CodexApprovalMethod.ExecCommand: {
			const wire = params as WireExecCommandApprovalParams;
			const sessionId = optionalString(wire.conversationId);
			const command = Array.isArray(wire.command)
				? wire.command.filter((part): part is string => typeof part === "string")
				: [];
			if (sessionId === undefined || command.length === 0) {
				return undefined;
			}
			const cwd = optionalString(wire.cwd);
			return {
				id: options.requestId,
				sessionId,
				type: "command",
				title: truncate(command.join(" ")),
				summary: optionalString(wire.reason) ?? cwd ?? "",
				risk: assessRisk({
					type: "command",
					command,
					...(cwd === undefined ? {} : { cwd }),
					...(projectPath === undefined ? {} : { projectPath }),
				}),
			};
		}

		case CodexApprovalMethod.ApplyPatch: {
			const wire = params as WireApplyPatchApprovalParams;
			const sessionId = optionalString(wire.conversationId);
			if (sessionId === undefined) {
				return undefined;
			}
			const paths = isRecord(wire.fileChanges) ? Object.keys(wire.fileChanges) : [];
			if (paths.length === 0) {
				return undefined;
			}
			return {
				id: options.requestId,
				sessionId,
				type: "file-change",
				title: paths.length === 1 ? truncate(paths[0] ?? "") : `${paths.length} files`,
				summary: optionalString(wire.reason) ?? truncate(paths.slice(0, 3).join(", ")),
				risk: assessRisk({
					type: "file-change",
					paths,
					...(projectPath === undefined ? {} : { projectPath }),
				}),
			};
		}

		default:
			return undefined;
	}
}
