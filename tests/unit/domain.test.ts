import { describe, expect, it } from "vitest";
import { AgentDeckError, errorBadge, toAgentDeckError } from "@/domain/errors.js";
import { formatGitCompact, formatGitSummary, type GitStatus } from "@/domain/git.js";
import { deriveProjectName, validateProjectPath } from "@/domain/project.js";
import { isInterruptible, pickActiveSession, type AgentSession } from "@/domain/session.js";
import {
	clampBarPercent,
	mostConstrainedWindow,
	providerStatusForError,
	remainingPercent,
	selectWindow,
	type UsageWindow,
} from "@/domain/usage.js";

const window = (id: string, usedPercent: number, resetsAt?: Date): UsageWindow => ({
	id,
	label: id,
	usedPercent,
	...(resetsAt === undefined ? {} : { resetsAt }),
});

describe("usage windows (design §7.3, §7.5)", () => {
	it("derives remaining rather than storing it", () => {
		expect(remainingPercent(window("a", 41))).toBe(59);
		// A provider may report over 100; remaining still floors at zero.
		expect(remainingPercent(window("a", 130))).toBe(0);
	});

	it("clamps only the drawn bar, never the model", () => {
		const raw = window("a", 130);
		expect(clampBarPercent(raw.usedPercent)).toBe(100);
		expect(raw.usedPercent).toBe(130);
		expect(clampBarPercent(Number.NaN)).toBe(0);
		expect(clampBarPercent(-5)).toBe(0);
	});

	it("auto mode follows the most constrained window", () => {
		const windows = [window("5h", 41), window("7d", 96)];
		expect(selectWindow(windows, { mode: "auto" })?.id).toBe("7d");
	});

	it("breaks ties on the window that resets soonest", () => {
		const soon = window("soon", 50, new Date(1_000));
		const later = window("later", 50, new Date(9_000));
		expect(mostConstrainedWindow([later, soon])?.id).toBe("soon");
	});

	it("returns nothing when a pinned window disappears, and does not substitute", () => {
		const windows = [window("5h", 41)];
		expect(selectWindow(windows, { mode: "pinned", windowId: "7d" })).toBeUndefined();
		expect(selectWindow(windows, { mode: "pinned", windowId: "5h" })?.id).toBe("5h");
	});

	it("maps failures onto the provider status machine (design §17.3)", () => {
		expect(providerStatusForError("NOT_AUTHENTICATED", true)).toBe("login-required");
		expect(providerStatusForError("CLI_NOT_FOUND", true)).toBe("cli-not-found");
		expect(providerStatusForError("RATE_LIMITED", false)).toBe("rate-limited");
		expect(providerStatusForError("PROVIDER_OFFLINE", true)).toBe("stale");
		expect(providerStatusForError("PROVIDER_OFFLINE", false)).toBe("error");
	});
});

describe("sessions (design §7.2, §12.2)", () => {
	const session = (id: string, state: AgentSession["state"], updatedAt: number): AgentSession => ({
		id,
		providerId: "codex",
		state,
		updatedAt: new Date(updatedAt),
	});

	it("prefers a working session over an idle one", () => {
		expect(pickActiveSession([session("a", "idle", 100), session("b", "working", 1)])?.id).toBe("b");
	});

	it("breaks ties on the most recently updated", () => {
		expect(pickActiveSession([session("a", "idle", 1), session("b", "idle", 100)])?.id).toBe("b");
	});

	it("only allows interrupting a session that is actually running", () => {
		expect(isInterruptible(session("a", "working", 1))).toBe(true);
		expect(isInterruptible(session("a", "waiting-approval", 1))).toBe(true);
		expect(isInterruptible(session("a", "idle", 1))).toBe(false);
		expect(isInterruptible(undefined)).toBe(false);
	});
});

describe("project validation (instructions §4)", () => {
	it("requires a non-empty absolute path", () => {
		expect(validateProjectPath("").code).toBe("empty-path");
		expect(validateProjectPath("relative/path").code).toBe("not-absolute");
		expect(validateProjectPath("C:\\src\\game").valid).toBe(true);
		expect(validateProjectPath("/home/dev/game").valid).toBe(true);
		expect(validateProjectPath("\\\\server\\share").valid).toBe(true);
		// Windows calls this absolute, but it resolves against the current drive —
		// not something a persisted setting should depend on.
		expect(validateProjectPath("\\src\\game").code).toBe("not-absolute");
	});

	it("uses filesystem facts supplied by the adapter", () => {
		expect(validateProjectPath("/a", { exists: false, isDirectory: false }).code).toBe("not-found");
		expect(validateProjectPath("/a", { exists: true, isDirectory: false }).code).toBe("not-a-directory");
		expect(validateProjectPath("/a", { exists: true, isDirectory: true }).valid).toBe(true);
	});

	it("derives a display name from either separator style", () => {
		expect(deriveProjectName("C:\\src\\game\\")).toBe("game");
		expect(deriveProjectName("/home/dev/game")).toBe("game");
	});
});

describe("git formatting (design §16.1)", () => {
	const status: GitStatus = {
		repositoryPath: "/repo",
		branch: "main",
		detached: false,
		hasCommits: true,
		modified: 4,
		staged: 2,
		untracked: 1,
		conflicted: 0,
		ahead: 1,
		behind: 0,
	};

	it("renders the touch-strip summary", () => {
		expect(formatGitSummary(status)).toBe("main | M:4 | S:2 | U:1 | ↑1 ↓0");
		expect(formatGitCompact(status)).toBe("main M:4");
	});

	it("labels a detached head", () => {
		expect(formatGitSummary({ ...status, branch: undefined, detached: true })).toContain("detached");
	});

	it("omits ahead/behind before the first commit", () => {
		const summary = formatGitSummary({ ...status, hasCommits: false, ahead: 0, behind: 0 });
		expect(summary).not.toContain("↑");
		expect(summary).toContain("main");
	});
});

describe("typed errors (instructions §10)", () => {
	it("gives every code a key-sized badge", () => {
		expect(errorBadge("CLI_NOT_FOUND")).toBe("CLI?");
		expect(errorBadge("NOT_AUTHENTICATED")).toBe("LOGIN");
		expect(errorBadge("PROVIDER_OFFLINE")).toBe("OFFLINE");
	});

	it("wraps unknown throwables without losing the message", () => {
		const wrapped = toAgentDeckError(new Error("boom"));
		expect(wrapped).toBeInstanceOf(AgentDeckError);
		expect(wrapped.code).toBe("UNKNOWN");
		expect(wrapped.message).toBe("boom");
	});

	it("passes an AgentDeckError through unchanged", () => {
		const original = new AgentDeckError("RATE_LIMITED", "slow down");
		expect(toAgentDeckError(original)).toBe(original);
		expect(original.retryable).toBe(true);
	});
});
