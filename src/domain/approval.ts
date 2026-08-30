/**
 * Approval domain model — design §12.4, §22.2.
 *
 * Declared in v0.1 so providers can already emit approval events, but the
 * approval UI itself is v0.4 (instructions §5). Two rules are structural and
 * hold from day one:
 *   - there is no "always approve" variant;
 *   - high-risk requests must be confirmed with a hold, never a single tap.
 */

export type ApprovalType = "command" | "file-change" | "other";
export type ApprovalRisk = "low" | "medium" | "high";

export interface ApprovalRequest {
	id: string;
	sessionId: string;
	type: ApprovalType;
	title: string;
	summary: string;
	risk: ApprovalRisk;
}

/** Only `approve-once` and `deny` exist. Design §12.4 / §22.2. */
export type ApprovalDecision = "approve-once" | "deny";

export function requiresHoldToApprove(request: ApprovalRequest): boolean {
	return request.risk === "high";
}
