/**
 * Provider → Application event contract — design §20.1.
 *
 * Providers push these; the application layer fans them out to only the affected
 * actions (design §20.2). No provider-specific payload may leak through here.
 */

import type { ApprovalRequest } from "./approval.js";
import type { AgentSession } from "./session.js";
import type { ProviderId, ProviderStatus, UsageSnapshot } from "./usage.js";

export type ProviderEvent =
	| { type: "usage-updated"; snapshot: UsageSnapshot }
	| { type: "session-updated"; session: AgentSession }
	| { type: "session-removed"; sessionId: string }
	| { type: "approval-requested"; request: ApprovalRequest }
	| { type: "approval-resolved"; approvalId: string }
	| { type: "provider-status"; providerId: ProviderId; status: ProviderStatus };

export type ProviderEventListener = (event: ProviderEvent) => void;

export type Unsubscribe = () => void;
