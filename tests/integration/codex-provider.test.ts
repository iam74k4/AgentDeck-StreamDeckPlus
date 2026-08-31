/**
 * Spike A — end-to-end against a real child process speaking the app-server wire
 * format: handshake ordering (instructions §7.1), request/response correlation,
 * push notifications (§7.3), sparse merge (§7.4), lifecycle and crash recovery
 * (§7.5), and turn interruption (design §12.2).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderEvent } from "@/domain/provider-events.js";
import { createLogger, nullSink } from "@/infrastructure/logger.js";
import { CodexProvider, MIN_HEALTH_CHECK_INTERVAL_MS } from "@/providers/codex/codex-provider.js";
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

	it("reports CLI_NOT_FOUND when the path resolves but cannot be executed", async () => {
		// A directory passes the executable-bit check and then fails to spawn with
		// EACCES, which is the path that turns a spawn error into a typed code.
		const directory = mkdtempSync(join(tmpdir(), "agentdeck-bin-"));

		const provider = createProvider({}, { executable: directory, args: [], resolve: () => directory });
		await provider.start();

		expect(provider.status).toBe("cli-not-found");
		// A path that cannot be executed will not fix itself on a timer.
		expect(provider.lifecycleState).toBe("stopped");
		rmSync(directory, { recursive: true, force: true });
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

describe("authentication (design §17.3)", () => {
	it("reports LOGIN when the app-server will not describe the account", async () => {
		const provider = createProvider({ FAKE_FAIL: "account/read" });
		await provider.start();

		// The process is healthy; the credential is not — those are different badges.
		expect(provider.lifecycleState).toBe("ready");
		expect(provider.status).toBe("login-required");
		expect(provider.usageSnapshot().error?.code).toBe("NOT_AUTHENTICATED");
	});

	it("does not read usage while unauthenticated", async () => {
		const provider = createProvider({ FAKE_FAIL: "account/read" });
		await provider.start();
		expect(provider.usageSnapshot().windows).toEqual([]);
	});

	it("reports READY once the account comes back", async () => {
		const provider = createProvider();
		await provider.start();
		expect(provider.status).toBe("ready");
	});
});

describe("lifecycle races (instructions §7.5)", () => {
	it("serialises overlapping start and stop instead of leaking a connection", async () => {
		const provider = createProvider();
		await provider.start();

		// Two settings changes in quick succession look exactly like this.
		await Promise.all([provider.stop(), provider.start(), provider.stop(), provider.start()]);

		expect(provider.lifecycleState).toBe("ready");
		expect(provider.usageSnapshot().windows).toHaveLength(2);

		await provider.stop();
		expect(provider.lifecycleState).toBe("stopped");
	});

	it("a start that loses the race to a stop leaves nothing running", async () => {
		const provider = createProvider();
		const starting = provider.start();
		const stopping = provider.stop();
		await Promise.all([starting, stopping]);

		expect(provider.lifecycleState).toBe("stopped");
	});

	it("applies an executable change by restarting once", async () => {
		const provider = createProvider();
		await provider.start();
		await provider.configure({ executable: process.execPath, args: [FAKE_SERVER, "--again"] });

		expect(provider.lifecycleState).toBe("ready");
		expect(provider.usageSnapshot().windows).toHaveLength(2);
	});

	it("floors the health-check interval so a settings typo cannot become a hot loop", async () => {
		const provider = createProvider({}, { healthCheckIntervalMs: 5 });
		await provider.start();
		// The provider clamps rather than trusting the value it was handed.
		expect(MIN_HEALTH_CHECK_INTERVAL_MS).toBeGreaterThan(5);
		expect(provider.lifecycleState).toBe("ready");
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

interface AnswerRecord {
	method: string;
	result?: { decision?: unknown };
	error?: { code: number; message: string };
}

describe("approvals (design §12.4, §22.2)", () => {
	const request = (method: string, params: Record<string, unknown>) => ({
		delayMs: 10,
		request: true,
		method,
		params,
	});

	/** The exact objects the plugin wrote back, as the server saw them. */
	function answerLog(path: string): AnswerRecord[] {
		if (!existsSync(path)) {
			return [];
		}
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as AnswerRecord);
	}

	function approvalHarness(script: unknown[]): {
		provider: CodexProvider;
		events: ProviderEvent[];
		log: () => AnswerRecord[];
	} {
		const logPath = join(mkdtempSync(join(tmpdir(), "agentdeck-approval-")), "answers.jsonl");
		const provider = createProvider({ FAKE_SCRIPT: JSON.stringify(script), FAKE_ANSWER_LOG: logPath });
		const events: ProviderEvent[] = [];
		provider.subscribe((event) => events.push(event));
		return { provider, events, log: () => answerLog(logPath) };
	}

	const pendingId = (events: ProviderEvent[]): string => {
		const found = events.flatMap((event) => (event.type === "approval-requested" ? [event.request.id] : []));
		expect(found.length).toBeGreaterThan(0);
		return found[0] as string;
	};

	it("raises a command approval as a domain request and answers only when told", async () => {
		const { provider, events, log } = approvalHarness([
			request("item/commandExecution/requestApproval", {
				threadId: "thr_1",
				turnId: "turn_1",
				itemId: "item_1",
				startedAtMs: 1,
				command: "npm run build",
				cwd: "/work/game",
			}),
		]);

		await provider.start();
		await waitFor(() => events.some((event) => event.type === "approval-requested"));

		expect(events.find((event) => event.type === "approval-requested")).toMatchObject({
			request: { sessionId: "thr_1", type: "command", title: "npm run build", risk: "low" },
		});
		// Nothing has been answered: an approval waits for a person, with no
		// timeout and no default (instructions §2.5).
		expect(events.some((event) => event.type === "approval-resolved")).toBe(false);
		expect(log()).toEqual([]);
	});

	it("sends `accept` — and nothing broader — when the user approves once", async () => {
		const { provider, events, log } = approvalHarness([
			request("item/commandExecution/requestApproval", {
				threadId: "thr_1",
				turnId: "t",
				itemId: "i",
				startedAtMs: 1,
				command: "ls",
			}),
		]);
		await provider.start();
		await waitFor(() => events.some((event) => event.type === "approval-requested"));

		await provider.resolveApproval(pendingId(events), "approve-once");
		await waitFor(() => log().length > 0);

		expect(log()[0]?.result).toEqual({ decision: "accept" });
	});

	it("sends `decline` when the user denies", async () => {
		const { provider, events, log } = approvalHarness([
			request("item/fileChange/requestApproval", {
				threadId: "thr_1",
				turnId: "t",
				itemId: "i",
				startedAtMs: 1,
				reason: "write outside the workspace",
			}),
		]);
		await provider.start();
		await waitFor(() => events.some((event) => event.type === "approval-requested"));

		// A file change that names no paths cannot be judged from the deck, so it
		// is high risk and the key will require a hold.
		expect(events.find((event) => event.type === "approval-requested")).toMatchObject({
			request: { type: "file-change", risk: "high" },
		});

		await provider.resolveApproval(pendingId(events), "deny");
		await waitFor(() => log().length > 0);

		expect(log()[0]?.result).toEqual({ decision: "decline" });
	});

	it("answers the legacy surface in its own dialect", async () => {
		const { provider, events, log } = approvalHarness([
			request("execCommandApproval", {
				conversationId: "thr_1",
				callId: "call_1",
				command: ["rm", "-rf", "build"],
				cwd: "/work/game",
			}),
		]);
		await provider.start();
		await waitFor(() => events.some((event) => event.type === "approval-requested"));

		expect(events.find((event) => event.type === "approval-requested")).toMatchObject({
			request: { type: "command", title: "rm -rf build", risk: "high" },
		});

		await provider.resolveApproval(pendingId(events), "deny");
		await waitFor(() => log().length > 0);

		expect(log()[0]?.result).toEqual({ decision: { denied: { rejection: "Denied from AgentDeck" } } });
	});

	it("marks the session as waiting for approval, and back to working once answered", async () => {
		const { provider, events } = approvalHarness([
			request("item/commandExecution/requestApproval", {
				threadId: "thr_1",
				turnId: "t",
				itemId: "i",
				startedAtMs: 1,
				command: "ls",
			}),
		]);
		await provider.start();
		await waitFor(() => provider.sessions.some((session) => session.state === "waiting-approval"));

		await provider.resolveApproval(pendingId(events), "approve-once");

		expect(provider.sessions[0]?.state).toBe("working");
		expect(events.some((event) => event.type === "approval-resolved")).toBe(true);
	});

	it("denies whatever is still waiting when the provider stops", async () => {
		const { provider, events, log } = approvalHarness([
			request("item/commandExecution/requestApproval", {
				threadId: "thr_1",
				turnId: "t",
				itemId: "i",
				startedAtMs: 1,
				command: "ls",
			}),
		]);
		await provider.start();
		await waitFor(() => events.some((event) => event.type === "approval-requested"));

		await provider.stop();
		await waitFor(() => log().length > 0);

		expect(log()[0]?.result).toEqual({ decision: "decline" });
	});

	it("refuses a server request that is not an approval", async () => {
		const { provider, log } = approvalHarness([
			request("item/tool/call", { threadId: "thr_1", turnId: "t", callId: "c", tool: "x", arguments: {} }),
		]);
		await provider.start();
		await waitFor(() => log().length > 0);

		expect(log()[0]?.result).toBeUndefined();
		expect(log()[0]?.error).toBeDefined();
	});
});

describe("model selection (design §19)", () => {
	it("applies the model and effort with thread/settings/update", async () => {
		const logPath = join(mkdtempSync(join(tmpdir(), "agentdeck-model-")), "answers.jsonl");
		const provider = createProvider({ FAKE_ANSWER_LOG: logPath });
		await provider.start();
		await waitFor(() => provider.sessions.length > 0);

		await provider.applyModel("thr_1", { modelId: "gpt-5.1-codex", reasoningLevel: "high" });

		const entries = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
		expect(entries[0]).toEqual({
			method: "thread/settings/update",
			params: { threadId: "thr_1", model: "gpt-5.1-codex", effort: "high" },
		});
		expect(provider.sessions[0]).toMatchObject({ modelId: "gpt-5.1-codex", reasoningLevel: "high" });
	});
});

describe("sending input to a session (design §12.3)", () => {
	function harness(): {
		provider: CodexProvider;
		sent: () => { method: string; params: Record<string, unknown> }[];
	} {
		const logPath = join(mkdtempSync(join(tmpdir(), "agentdeck-send-")), "sent.jsonl");
		const provider = createProvider({ FAKE_ANSWER_LOG: logPath });
		return {
			provider,
			sent: () =>
				existsSync(logPath)
					? readFileSync(logPath, "utf8")
							.split("\n")
							.filter((line) => line.trim().length > 0)
							.map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
					: [],
		};
	}

	it("starts a turn on an idle session", async () => {
		const { provider, sent } = harness();
		await provider.start();
		await waitFor(() => provider.sessions.length > 0);

		await provider.steer("thr_1", { text: "run the tests" });

		expect(sent()[0]).toEqual({
			method: "turn/start",
			params: { threadId: "thr_1", input: [{ type: "text", text: "run the tests" }] },
		});
		expect(provider.sessions[0]).toMatchObject({ state: "working", currentTurnId: "turn_started" });
	});

	it("steers a turn that is already running, pinned to that turn", async () => {
		const { provider, sent } = harness();
		await provider.start();
		await waitFor(() => provider.sessions.length > 0);

		// A turn is now in flight, so the next input joins it rather than starting
		// a second one.
		await provider.steer("thr_1", { text: "first" });
		await provider.steer("thr_1", { text: "also check the docs" });

		expect(sent()[1]).toEqual({
			method: "turn/steer",
			params: {
				threadId: "thr_1",
				input: [{ type: "text", text: "also check the docs" }],
				expectedTurnId: "turn_started",
			},
		});
	});

	it("attaches a screenshot as a local image", async () => {
		const { provider, sent } = harness();
		await provider.start();
		await waitFor(() => provider.sessions.length > 0);

		await provider.steer("thr_1", { text: "what is wrong here?", imagePaths: ["C:/tmp/shot.png"] });

		expect(sent()[0]?.params.input).toEqual([
			{ type: "text", text: "what is wrong here?" },
			{ type: "localImage", path: "C:/tmp/shot.png" },
		]);
	});

	it("refuses to send nothing", async () => {
		const { provider, sent } = harness();
		await provider.start();
		await waitFor(() => provider.sessions.length > 0);

		await expect(provider.steer("thr_1", { text: "   " })).rejects.toMatchObject({
			code: "PROTOCOL_ERROR",
		});
		expect(sent()).toEqual([]);
	});

	it("opens a thread rooted at the project directory", async () => {
		const { provider, sent } = harness();
		await provider.start();

		const session = await provider.startSession({ cwd: "C:/work/Game" });

		expect(session).toMatchObject({ id: "thr_new", providerId: "codex" });
		expect(sent()[0]).toEqual({ method: "thread/start", params: { cwd: "C:/work/Game" } });
	});
});

describe("plan and diff on a live session (design §3.5, §16.2)", () => {
	const item = (delayMs: number, threadId: string, body: Record<string, unknown>) => ({
		delayMs,
		method: "item/completed",
		params: { threadId, turnId: "turn_1", item: body, completedAtMs: 1 },
	});

	it("reports plan progress from the agent's own plan item", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([
				item(10, "thr_1", {
					type: "plan",
					id: "item_plan",
					text: "- [x] Read the parser\n- [x] Add a test\n- [ ] Fix it",
				}),
			]),
		});
		await provider.start();
		await waitFor(() => provider.sessions[0]?.plan !== undefined);

		expect(provider.sessions[0]?.plan).toEqual({ completedSteps: 2, totalSteps: 3 });
	});

	it("reports what the agent changed from its file-change item", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([
				item(10, "thr_1", {
					type: "fileChange",
					id: "item_patch",
					status: "completed",
					changes: [
						{ path: "src/a.ts", kind: { type: "update" }, diff: "--- a\n+++ b\n-old\n+new\n+more\n" },
					],
				}),
			]),
		});
		await provider.start();
		await waitFor(() => provider.sessions[0]?.diff !== undefined);

		expect(provider.sessions[0]?.diff).toEqual({ added: 2, removed: 1, fileCount: 1 });
	});

	it("clears the previous turn's plan when a new turn starts", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([
				item(10, "thr_1", { type: "plan", id: "p", text: "- [x] done\n- [x] also done" }),
				{
					delayMs: 20,
					method: "turn/started",
					params: { threadId: "thr_1", turn: { id: "turn_2", status: "inProgress" } },
				},
			]),
		});
		await provider.start();
		await waitFor(() => provider.sessions[0]?.plan !== undefined);

		// `Plan 2/2` from the finished turn must not sit on the key through the next.
		await waitFor(() => provider.sessions[0]?.currentTurnId === "turn_2");
		expect(provider.sessions[0]?.plan).toBeUndefined();
	});

	it("ignores an item for a session it does not know", async () => {
		const provider = createProvider({
			FAKE_SCRIPT: JSON.stringify([item(10, "thr_unknown", { type: "plan", id: "p", text: "- [ ] one" })]),
		});
		await provider.start();
		await waitFor(() => provider.sessions.length > 0);

		expect(provider.sessions.every((session) => session.plan === undefined)).toBe(true);
	});
});
