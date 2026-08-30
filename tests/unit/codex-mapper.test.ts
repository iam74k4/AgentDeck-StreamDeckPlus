/**
 * Design §9.4 (sparse update) and §7.3 (window normalisation) — the two rules a
 * Codex protocol change is most likely to break.
 */
import { describe, expect, it } from "vitest";
import {
	applyFullRateLimits,
	applyRateLimitsUpdate,
	createRateLimitState,
	DEFAULT_LIMIT_BUCKET,
	formatWindowLabel,
	isRateLimitReached,
	mergeRateLimitSnapshot,
	threadStatusToSessionState,
	toUsageWindows,
	turnStatusToSessionState,
	wireModelToDescriptor,
	wireThreadToSession,
} from "@/providers/codex/mapper.js";
import type { WireGetAccountRateLimitsResponse, WireThreadStatus } from "@/providers/codex/protocol.js";

const FULL: WireGetAccountRateLimitsResponse = {
	rateLimits: {
		limitId: null,
		limitName: "Codex",
		primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1_800_000_000 },
		secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
		planType: "plus",
		rateLimitReachedType: null,
	},
};

describe("rate limit merging (design §9.4)", () => {
	it("keeps known values when the update omits them", () => {
		const merged = mergeRateLimitSnapshot(
			{ limitName: "Codex", primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 100 } },
			{ primary: { usedPercent: 55 } },
		);

		expect(merged.primary).toEqual({ usedPercent: 55, windowDurationMins: 300, resetsAt: 100 });
		expect(merged.limitName).toBe("Codex");
	});

	it("keeps known values when the update sends explicit nulls", () => {
		const merged = mergeRateLimitSnapshot(
			{
				limitName: "Codex",
				primary: { usedPercent: 41, windowDurationMins: 300 },
				secondary: { usedPercent: 9 },
			},
			{ limitName: null, primary: { usedPercent: 60, windowDurationMins: null }, secondary: null },
		);

		expect(merged.limitName).toBe("Codex");
		expect(merged.primary).toEqual({ usedPercent: 60, windowDurationMins: 300 });
		expect(merged.secondary).toEqual({ usedPercent: 9 });
	});

	it("applies a sparse notification on top of the last full snapshot", () => {
		let state = applyFullRateLimits(createRateLimitState(), FULL);
		state = applyRateLimitsUpdate(state, { rateLimits: { primary: { usedPercent: 77 } } });

		const windows = toUsageWindows(state);
		expect(windows).toHaveLength(2);
		expect(windows[0]).toMatchObject({ id: `${DEFAULT_LIMIT_BUCKET}.primary`, usedPercent: 77, label: "5h" });
		// The untouched secondary window survives the sparse update.
		expect(windows[1]).toMatchObject({
			id: `${DEFAULT_LIMIT_BUCKET}.secondary`,
			usedPercent: 12,
			label: "7d",
		});
	});

	it("ignores an update with no snapshot at all", () => {
		const state = applyFullRateLimits(createRateLimitState(), FULL);
		expect(applyRateLimitsUpdate(state, {})).toBe(state);
		expect(applyRateLimitsUpdate(state, { rateLimits: null })).toBe(state);
	});

	it("tracks multiple metered buckets independently", () => {
		let state = applyFullRateLimits(createRateLimitState(), {
			rateLimits: {
				limitId: "codex",
				limitName: "Codex",
				primary: { usedPercent: 10, windowDurationMins: 300 },
			},
			rateLimitsByLimitId: {
				codex: {
					limitId: "codex",
					limitName: "Codex",
					primary: { usedPercent: 10, windowDurationMins: 300 },
				},
				review: {
					limitId: "review",
					limitName: "Review",
					primary: { usedPercent: 90, windowDurationMins: 1440 },
				},
			},
		});
		state = applyRateLimitsUpdate(state, { rateLimits: { limitId: "review", primary: { usedPercent: 95 } } });

		const windows = toUsageWindows(state);
		expect(windows.map((w) => w.id)).toEqual(["codex.primary", "review.primary"]);
		expect(windows[1]?.usedPercent).toBe(95);
		// With several buckets the label is qualified so two rows stay distinguishable.
		expect(windows[1]?.label).toBe("Review 1d");
	});

	it("reports when the account has hit a limit", () => {
		const state = applyRateLimitsUpdate(createRateLimitState(), {
			rateLimits: { primary: { usedPercent: 100 }, rateLimitReachedType: "rateLimitReached" },
		});
		expect(isRateLimitReached(state)).toBe(true);
	});

	it("drops windows the provider reports without a usable percentage", () => {
		const state = applyFullRateLimits(createRateLimitState(), {
			rateLimits: { primary: { usedPercent: null }, secondary: { usedPercent: 5 } },
		});
		expect(toUsageWindows(state).map((w) => w.id)).toEqual([`${DEFAULT_LIMIT_BUCKET}.secondary`]);
	});

	it("converts reset timestamps from unix seconds", () => {
		const state = applyFullRateLimits(createRateLimitState(), FULL);
		expect(toUsageWindows(state)[0]?.resetsAt?.getTime()).toBe(1_800_000_000 * 1000);
	});
});

describe("window labels (design §7.3 — durations are not fixed to 5h/7d)", () => {
	it.each([
		[300, "5h"],
		[10_080, "7d"],
		[1440, "1d"],
		[45, "45m"],
		[90, "2h"],
	])("formats %i minutes as %s", (minutes, expected) => {
		expect(formatWindowLabel(minutes)).toBe(expected);
	});

	it("returns undefined for an unreported duration", () => {
		expect(formatWindowLabel(undefined)).toBeUndefined();
		expect(formatWindowLabel(null)).toBeUndefined();
		expect(formatWindowLabel(0)).toBeUndefined();
	});
});

describe("session state mapping (design §7.2)", () => {
	const cases: [WireThreadStatus, string][] = [
		[{ type: "idle" }, "idle"],
		[{ type: "systemError" }, "error"],
		[{ type: "notLoaded" }, "disconnected"],
		[{ type: "active", activeFlags: [] }, "working"],
		[{ type: "active", activeFlags: ["waitingOnApproval"] }, "waiting-approval"],
		// The agent is not doing work, so the deck must not read WORKING.
		[{ type: "active", activeFlags: ["waitingOnUserInput"] }, "idle"],
	];

	it.each(cases)("maps %j", (status, expected) => {
		expect(threadStatusToSessionState(status)).toBe(expected);
	});

	it.each([
		["inProgress", "working"],
		["completed", "completed"],
		["failed", "error"],
		["interrupted", "idle"],
	] as const)("maps turn status %s", (status, expected) => {
		expect(turnStatusToSessionState(status)).toBe(expected);
	});

	it("maps a thread onto a domain session", () => {
		const session = wireThreadToSession(
			{ id: "thr_1", preview: "  Fix the parser  ", status: { type: "active" }, createdAt: 1_700_000_000 },
			"codex",
		);
		expect(session).toMatchObject({
			id: "thr_1",
			providerId: "codex",
			state: "working",
			label: "Fix the parser",
		});
		expect(session.startedAt?.getTime()).toBe(1_700_000_000 * 1000);
	});
});

describe("model descriptors (design §19 — never hard-coded)", () => {
	it("prefers the display name and carries reasoning levels", () => {
		expect(
			wireModelToDescriptor({
				id: "gpt-5.1-codex",
				displayName: "GPT-5.1 Codex",
				supportedReasoningEfforts: ["fast", "medium"],
			}),
		).toEqual({ id: "gpt-5.1-codex", label: "GPT-5.1 Codex", reasoningLevels: ["fast", "medium"] });
	});

	it("falls back to the id when no display name is reported", () => {
		expect(wireModelToDescriptor({ id: "custom" })).toEqual({ id: "custom", label: "custom" });
	});
});
