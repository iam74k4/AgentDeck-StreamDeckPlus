/**
 * Spike A — end-to-end against a real child process speaking the app-server wire
 * format: handshake ordering (instructions §7.1), request/response correlation,
 * push notifications (§7.3), sparse merge (§7.4), lifecycle and crash recovery
 * (§7.5), and turn interruption (design §12.2).
 */
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderEvent } from "@/domain/provider-events.js";
import { createLogger, nullSink } from "@/infrastructure/logger.js";
import { CodexProvider } from "@/providers/codex/codex-provider.js";
import { waitFor } from "../helpers/wait.js";

const FAKE_SERVER = fileURLToPath(new URL("../helpers/fake-codex-app-server.mjs", import.meta.url));
const logger = createLogger({ sink: nullSink });

const started: CodexProvider[] = [];

function createProvider(env: NodeJS.ProcessEnv = {}, overrides: Record<string, unknown> = {}): CodexProvider {
	const provider = new CodexProvider({
		executable: process.execPath,
		args: [FAKE_SERVER],
		env: { ...process.env, ...env },
		logger,
		autoRestart: false,
		healthCheckIntervalMs: 60_000,
		...overrides,
	});
	started.push(provider);
	return provider;
}

afterEach(async () => {
	await Promise.all(started.splice(0).map((provider) => provider.stop()));
});

describe("codex app-server lifecycle", () => {
	it("completes the handshake and reaches READY", async () => {
		const provider = createProvider();
		expect(provider.lifecycleState).toBe("stopped");

		await provider.start();

		expect(provider.lifecycleState).toBe("ready");
		expect(provider.status).toBe("ready");
	});

	it("reads rate limits during startup and maps them to domain windows", async () => {
		const provider = createProvider();
		await provider.start();

		const snapshot = provider.usageSnapshot();
		expect(snapshot.providerId).toBe("codex");
		expect(snapshot.windows.map((w) => [w.label, w.usedPercent])).toEqual([
			["5h", 41],
			["7d", 12],
		]);
		expect(snapshot.lastSuccessAt).toBeInstanceOf(Date);
	});

	it("lists threads as domain sessions", async () => {
		const provider = createProvider();
		await provider.start();

		await waitFor(() => provider.sessions.length > 0);
		expect(provider.sessions[0]).toMatchObject({ id: "thr_1", providerId: "codex", state: "idle" });
	});

	it("reports CLI_NOT_FOUND without retrying when the executable is missing", async () => {
		const provider = createProvider({}, { executable: "definitely-not-codex-xyz" });
		const events: ProviderEvent[] = [];
		provider.subscribe((event) => events.push(event));

		await provider.start();

		expect(provider.status).toBe("cli-not-found");
		expect(provider.lifecycleState).toBe("stopped");
		expect(events.some((e) => e.type === "provider-status" && e.status === "cli-not-found")).toBe(true);
	});

	it("times out instead of hanging when the server never answers initialize", async () => {
		const provider = createProvider({ FAKE_NO_INIT_REPLY: "1" }, { initializeTimeoutMs: 250 });

		const start = Date.now();
		await provider.start();

		expect(provider.lifecycleState).not.toBe("ready");
		expect(provider.status).toBe("error");
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	it("reports ERROR when the very first usage read fails", async () => {
		const provider = createProvider({ FAKE_FAIL: "account/rateLimits/read" });
		await provider.start();

		// The app-server itself is fine, but there is no usable data behind it.
		expect(provider.lifecycleState).toBe("ready");
		expect(provider.usageSnapshot().status).toBe("error");
		expect(provider.usageSnapshot().error?.code).toBe("PROTOCOL_ERROR");
	});

	it("keeps the last good windows and reports STALE once a later read fails", async () => {
		const provider = createProvider({ FAKE_SCRIPT: JSON.stringify([{ delayMs: 60, exit: 1 }]) });
		await provider.start();
		expect(provider.usageSnapshot().windows).toHaveLength(2);

		await waitFor(() => provider.lifecycleState === "stopped", { message: "server never exited" });
		await expect(provider.refreshUsage()).rejects.toMatchObject({ code: "PROVIDER_OFFLINE" });

		const snapshot = provider.usageSnapshot();
		expect(snapshot.status).toBe("stale");
		// The last successful read is still what the deck shows (design §27).
		expect(snapshot.windows.map((w) => w.usedPercent)).toEqual([41, 12]);
		expect(snapshot.lastSuccessAt).toBeInstanceOf(Date);
	});
});

describe("push notifications (instructions §7.3, §7.4)", () => {
	it("merges a sparse rate-limit update into the last full snapshot", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([
				{
					delayMs: 20,
					method: "account/rateLimits/updated",
					params: { rateLimits: { primary: { usedPercent: 88 } } },
				},
			]),
		});

		const events: ProviderEvent[] = [];
		provider.subscribe((event) => events.push(event));
		await provider.start();

		await waitFor(() => provider.usageSnapshot().windows[0]?.usedPercent === 88);

		const windows = provider.usageSnapshot().windows;
		// The sparse update carried only `usedPercent`; everything else survives.
		expect(windows[0]).toMatchObject({ label: "5h", usedPercent: 88, windowDurationMinutes: 300 });
		expect(windows[1]).toMatchObject({ label: "7d", usedPercent: 12 });
		expect(events.some((e) => e.type === "usage-updated")).toBe(true);
	});

	it("tracks turn state through started and completed notifications", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([
				{ delayMs: 20, method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_9" } } },
				{
					delayMs: 40,
					method: "turn/completed",
					params: {
						threadId: "thr_1",
						turn: { id: "turn_9", status: "completed", tokenUsage: { inputTokens: 100, outputTokens: 50 } },
					},
				},
			]),
		});

		await provider.start();
		await waitFor(() => provider.sessions.some((s) => s.state === "working"));
		expect(provider.sessions.find((s) => s.id === "thr_1")?.currentTurnId).toBe("turn_9");

		await waitFor(() => provider.sessions.some((s) => s.state === "completed"));
		const session = provider.sessions.find((s) => s.id === "thr_1");
		expect(session?.currentTurnId).toBeUndefined();
		expect(session?.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 50 });
	});

	it("maps thread status changes onto session state", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([
				{
					delayMs: 20,
					method: "thread/status/changed",
					params: { threadId: "thr_1", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
				},
			]),
		});

		await provider.start();
		await waitFor(() => provider.sessions.some((s) => s.state === "waiting-approval"));
	});

	it("ignores a malformed notification instead of failing", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([
				{ delayMs: 10, method: "turn/started", params: { nonsense: true } },
				{ delayMs: 20, method: "account/rateLimits/updated", params: null },
				{ delayMs: 30, method: "totally/unknown", params: { a: 1 } },
				{
					delayMs: 40,
					method: "account/rateLimits/updated",
					params: { rateLimits: { primary: { usedPercent: 55 } } },
				},
			]),
		});

		await provider.start();
		await waitFor(() => provider.usageSnapshot().windows[0]?.usedPercent === 55);
		expect(provider.lifecycleState).toBe("ready");
	});
});

describe("turn interruption (design §12.2)", () => {
	it("interrupts the turn it learned about from turn/started", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([
				{ delayMs: 20, method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_9" } } },
			]),
		});

		await provider.start();
		await waitFor(() => provider.sessions.some((s) => s.state === "working"));

		await provider.interrupt("thr_1");

		// The fake answers an interrupt with turn/completed{status:"interrupted"}.
		await waitFor(() => provider.sessions.find((s) => s.id === "thr_1")?.state === "idle");
	});

	it("falls back to thread/read when no turn id is known yet", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([
				{
					delayMs: 20,
					method: "thread/status/changed",
					params: { threadId: "thr_1", status: { type: "active", activeFlags: [] } },
				},
			]),
		});

		await provider.start();
		await waitFor(() => provider.sessions.some((s) => s.state === "working"));
		expect(provider.sessions.find((s) => s.id === "thr_1")?.currentTurnId).toBeUndefined();

		await expect(provider.interrupt("thr_1")).resolves.toBeUndefined();
	});

	it("refuses to interrupt when there is no in-flight turn", async () => {
		const provider = createProvider({ FAKE_FAIL: "thread/read" });
		await provider.start();
		await expect(provider.interrupt("thr_1")).rejects.toMatchObject({ code: "INTERRUPTED" });
	});

	it("rejects calls made while the provider is offline", async () => {
		const provider = createProvider();
		await expect(provider.interrupt("thr_1")).rejects.toMatchObject({ code: "PROVIDER_OFFLINE" });
	});
});

describe("crash handling (instructions §7.5)", () => {
	it("marks sessions disconnected and stays alive when the process dies", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([{ delayMs: 40, exit: 1 }]),
		});
		const events: ProviderEvent[] = [];
		provider.subscribe((event) => events.push(event));

		await provider.start();
		await waitFor(() => provider.sessions.length > 0);
		await waitFor(() => provider.lifecycleState === "stopped", {
			message: "provider never noticed the crash",
		});

		expect(provider.sessions.every((session) => session.state === "disconnected")).toBe(true);
		expect(provider.status).toBe("stale");
		expect(events.some((e) => e.type === "provider-status")).toBe(true);
	});

	it("restarts after a crash when auto-restart is on", async () => {
		const provider = createProvider(
			{ FAKE_SCRIPT: JSON.stringify([{ delayMs: 40, exit: 1 }]) },
			{ autoRestart: true, backoff: { initialDelayMs: 20, maxDelayMs: 50 } },
		);

		await provider.start();
		await waitFor(() => provider.lifecycleState === "backoff", { message: "never entered backoff" });
		// The restarted server runs the same script, so it crashes again — the point
		// is that the provider keeps cycling instead of giving up or throwing.
		await waitFor(() => provider.lifecycleState === "ready" || provider.lifecycleState === "starting", {
			timeoutMs: 3_000,
			message: "never attempted a restart",
		});
	});

	it("shuts the child process down cleanly on stop", async () => {
		const provider = createProvider();
		await provider.start();
		await provider.stop();

		expect(provider.lifecycleState).toBe("stopped");
		// A second stop is a no-op rather than an error.
		await expect(provider.stop()).resolves.toBeUndefined();
	});
});

describe("models (design §19)", () => {
	it("reads the model list from the provider rather than a hard-coded table", async () => {
		const provider = createProvider();
		await provider.start();
		await expect(provider.getModels()).resolves.toEqual([
			{ id: "gpt-5.1-codex", label: "GPT-5.1 Codex", reasoningLevels: ["medium"] },
		]);
	});
});
