/**
 * Approval view models — design §12.4, §22.2.
 *
 *   ┌────────┬────────┐
 *   │ HOLD   │  DENY  │
 *   │APPROVE │        │
 *   └────────┴────────┘
 *
 * The Approve key states plainly whether a hold is required, because the
 * difference between a tap and a hold is the difference between a low-risk
 * command and one that can destroy work.
 */

import type { ApprovalRequest } from "../../domain/approval.js";
import { requiresHoldToApprove } from "../../domain/approval.js";
import { Palette } from "./colors.js";

export interface ApprovalKeyViewModel {
	/** `APPROVE`, `HOLD` or `DENY`. */
	label: string;
	/** Second line: what is being asked for, or why the key is inactive. */
	detail: string;
	color: string;
	/** False when nothing is waiting, which renders the key dimmed. */
	active: boolean;
	requiresHold: boolean;
	/** 0…1 while a hold is in progress. */
	holdProgress: number;
}

const RISK_COLORS = {
	low: Palette.ok,
	medium: Palette.warn,
	high: Palette.danger,
} as const;

/** Short, key-sized description of what is being approved. */
export function approvalDetail(request: ApprovalRequest): string {
	return request.title.length > 0 ? request.title : request.type;
}

export function buildApproveKeyViewModel(input: {
	request?: ApprovalRequest;
	/** 0…1 while the key is held down. */
	holdProgress?: number;
}): ApprovalKeyViewModel {
	const request = input.request;
	if (request === undefined) {
		return {
			label: "APPROVE",
			detail: "nothing waiting",
			color: Palette.offline,
			active: false,
			requiresHold: false,
			holdProgress: 0,
		};
	}
	const hold = requiresHoldToApprove(request);
	return {
		label: hold ? "HOLD" : "APPROVE",
		detail: approvalDetail(request),
		color: RISK_COLORS[request.risk],
		active: true,
		requiresHold: hold,
		holdProgress: Math.min(1, Math.max(0, input.holdProgress ?? 0)),
	};
}

/** Design §22.2 — "Denyは即時押下可": Deny is always a single press. */
export function buildDenyKeyViewModel(input: { request?: ApprovalRequest }): ApprovalKeyViewModel {
	const request = input.request;
	return {
		label: "DENY",
		detail: request === undefined ? "nothing waiting" : approvalDetail(request),
		color: request === undefined ? Palette.offline : Palette.danger,
		active: request !== undefined,
		requiresHold: false,
		holdProgress: 0,
	};
}
