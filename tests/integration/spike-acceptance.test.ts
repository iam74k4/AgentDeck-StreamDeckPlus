/**
 * Technical Spike acceptance (instructions §3 "Technical Spike成功条件").
 *
 * Everything except the physical device: a real child process speaking the
 * app-server protocol, the real services, the real coordinator, and four fake
 * encoder contexts standing in for the Stream Deck +'s touch strip.
 *
 *   CODEX
 *   ● WORKING / IDLE
 *   Usage xx%
 *
 * plus STOP interrupting the running turn.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { createLogger, nullSink } from "@/infrastructure/logger.js";
import {
	ENCODER_COLUMN_COUNT,
	type Column,
	type EncoderContext,
} from "@/presentation/plus-dashboard-coordinator.js";
import type { SegmentFeedback } from "@/presentation/renderers/encoder-renderer.js";
import {
	renderAgentStatusKey,
	renderStopKey,
	renderUsageKey,
} from "@/presentation/renderers/key-renderer.js";
import { buildAgentStatusViewModel } from "@/presentation/view-models/agent-status.js";
import { buildUsageViewModel } from "@/presentation/view-models/usage.js";
import { createRuntime, type AgentDeckRuntime } from "@/runtime.js";
import { waitFor } from "../helpers/wait.js";

const FAKE_SERVER = fileURLToPath(new URL("../helpers/fake-codex-app-server.mjs", import.meta.url));

let repo: string;
let runtime: AgentDeckRuntime | undefined;

/** A stand-in for one 200x100 encoder region. */
class FakeEncoder implements EncoderContext {
	public last: SegmentFeedback | undefined;
	public constructor(public readonly id: string) {}
	public setFeedback(feedback: SegmentFeedback): void {
		this.last = feedback;
	}
}

function makeRuntime(env: NodeJS.ProcessEnv = {}): { runtime: AgentDeckRuntime; encoders: FakeEncoder[] } {
	const created = createRuntime({
		logger: createLogger({ sink: nullSink }),
		codex: {
			executable: process.execPath,
			args: [FAKE_SERVER],
			env: { ...process.env, ...env },
			autoRestart: false,
			healthCheckIntervalMs: 60_000,
		},
	});

	const encoders: FakeEncoder[] = [];
	for (let column = 0; column < ENCODER_COLUMN_COUNT; column += 1) {
		const encoder = new FakeEncoder(`enc-${column}`);
		encoders.push(encoder);
		created.dashboard.register("device-1", column as Column, encoder);
	}
	created.setDashboardContext({ repositoryPath: repo });
	runtime = created;
	return { runtime: created, encoders };
}

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), "agentdeck-spike-"));
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "AgentDeck Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "AgentDeck Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};
	execFileSync("git", ["init", "--initial-branch=main", "."], { cwd: repo, env });
	writeFileSync(join(repo, "README.md"), "# spike\n");
	execFileSync("git", ["add", "README.md"], { cwd: repo, env });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, env });
	writeFileSync(join(repo, "dirty.txt"), "dirty\n");
});

afterEach(async () => {
	await runtime?.stop();
	runtime = undefined;
});

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("technical spike acceptance", () => {
	it("shows Codex usage, agent status, git and provider health across the touch strip", async () => {
		const { runtime: rt, encoders } = makeRuntime();
		await rt.start();
		rt.git.watch(repo);

		await waitFor(() => encoders[0]?.last?.value.value === "96%" || encoders[0]?.last?.value.value === "41%");
		await waitFor(() => encoders[2]?.last?.value.value === "main");

		expect(encoders[0]?.last?.title.value).toBe("CODEX");
		// Auto mode surfaces the most constrained window: 41% over 5h vs 12% over 7d.
		expect(encoders[0]?.last?.value.value).toBe("41%");
		// The window label stays visible even with the reset countdown appended.
		expect(encoders[0]?.last?.detail.value).toContain("5h");

		expect(encoders[1]?.last?.title.value).toBe("AGENT");
		expect(encoders[1]?.last?.value.value).toBe("IDLE");

		expect(encoders[2]?.last?.title.value).toBe("GIT");
		expect(encoders[2]?.last?.detail.value).toContain("U:1");

		expect(encoders[3]?.last?.title.value).toBe("CODEX");
		expect(encoders[3]?.last?.value.value).toBe("READY");
	});

	it("renders the spike's key faces from live provider state", async () => {
		const { runtime: rt } = makeRuntime();
		await rt.start();
		await waitFor(() => rt.sessions.list().length > 0);

		const snapshot = rt.usage.getSnapshot(rt.defaultProviderId);
		const usageKey = decodeURIComponent(
			renderUsageKey(buildUsageViewModel({ providerLabel: "Codex", snapshot, selection: { mode: "auto" } })),
		);
		expect(usageKey).toContain("CODEX");
		expect(usageKey).toContain("41%");

		const agentKey = decodeURIComponent(
			renderAgentStatusKey(
				buildAgentStatusViewModel({
					providerLabel: "Codex",
					providerStatus: snapshot?.status ?? "loading",
					session: rt.sessions.getActiveSession(),
				}),
			),
		);
		expect(agentKey).toContain("IDLE");
	});

	it("flips the strip and the STOP key to WORKING when a turn starts", async () => {
		const { runtime: rt, encoders } = makeRuntime({
			FAKE_SCRIPT: JSON.stringify([
				{ delayMs: 30, method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_9" } } },
			]),
		});
		await rt.start();

		await waitFor(() => encoders[1]?.last?.value.value === "WORKING", {
			message: "agent segment never showed WORKING",
		});

		const session = rt.sessions.getActiveSession();
		expect(session?.state).toBe("working");
		expect(decodeURIComponent(renderStopKey(true))).toContain('opacity="1"');
	});

	it("stops the running turn through the STOP path", async () => {
		const { runtime: rt } = makeRuntime({
			FAKE_SCRIPT: JSON.stringify([
				{ delayMs: 30, method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_9" } } },
			]),
		});
		await rt.start();
		await waitFor(() => rt.sessions.getActiveSession()?.state === "working");

		await rt.sessions.interruptActive();

		// The server answers an interrupt with turn/completed{status:"interrupted"}.
		await waitFor(() => rt.sessions.getActiveSession()?.state === "idle", {
			message: "session never left the working state",
		});
	});

	it("keeps the deck readable when the Codex CLI is not installed", async () => {
		const created = createRuntime({
			logger: createLogger({ sink: nullSink }),
			codex: { executable: "definitely-not-codex-xyz", autoRestart: false },
		});
		runtime = created;
		const encoder = new FakeEncoder("enc-0");
		created.dashboard.register("device-1", 0, encoder);

		await created.start();
		created.refreshDashboard();

		expect(encoder.last?.value.value).toBe("CLI?");
	});

	it("survives the app-server dying without taking the plugin down", async () => {
		const { runtime: rt, encoders } = makeRuntime({
			FAKE_SCRIPT: JSON.stringify([{ delayMs: 50, exit: 1 }]),
		});
		await rt.start();
		await waitFor(() => rt.sessions.list().length > 0);

		await waitFor(() => rt.sessions.list().every((session) => session.state === "disconnected"), {
			message: "sessions were never marked disconnected",
		});
		rt.refreshDashboard();

		// The last good usage reading is still on the strip, flagged as stale.
		expect(encoders[0]?.last?.value.value).toBe("41%");
		expect(encoders[0]?.last?.detail.value).toContain("STALE");
		expect(encoders[1]?.last?.value.value).toBe("OFFLINE");
	});
});
