/**
 * Design §20.2 — only affected actions redraw, and the 1 Hz elapsed-time timer
 * runs only while something is both working and being watched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitService } from "@/application/git-service.js";
import { ProjectService } from "@/application/project-service.js";
import { ApprovalService } from "@/application/approval-service.js";
import { ModelService } from "@/application/model-service.js";
import { PromptService } from "@/application/prompt-service.js";
import { VoiceService } from "@/application/voice-service.js";
import { ProviderRegistry } from "@/application/provider-registry.js";
import { SessionService } from "@/application/session-service.js";
import { UsageService } from "@/application/usage-service.js";
import type { AgentSession } from "@/domain/session.js";
import { UiCoordinator } from "@/presentation/ui-coordinator.js";
import {
	ControllableProvider,
	gitStatus,
	memoryProjectStore,
	usageSnapshot,
} from "../helpers/fake-runtime.js";

function setup(): { ui: UiCoordinator; provider: ControllableProvider; dispose: () => void } {
	const registry = new ProviderRegistry();
	const provider = new ControllableProvider();
	registry.register(provider);
	const usage = new UsageService(registry);
	const sessions = new SessionService(registry);
	const git = new GitService(
		{ isRepository: async () => true, getStatus: async (path) => gitStatus({ repositoryPath: path }) },
		{ pollIntervalMs: 600_000 },
	);
	const projects = new ProjectService({ store: memoryProjectStore() });
	const approvals = new ApprovalService(registry);
	const models = new ModelService(registry, sessions);
	const prompts = new PromptService(sessions);
	const voice = new VoiceService(prompts);
	const ui = new UiCoordinator(
		{ registry, usage, sessions, git, projects, approvals, models, prompts, voice },
		{ tickIntervalMs: 1_000 },
	);
	return {
		ui,
		provider,
		dispose: () => {
			ui.dispose();
			projects.dispose();
			git.dispose();
			sessions.dispose();
			usage.dispose();
		},
	};
}

const working = (): AgentSession => ({
	id: "thr_1",
	providerId: "codex",
	state: "working",
	startedAt: new Date(),
	updatedAt: new Date(),
});

afterEach(() => {
	vi.useRealTimers();
});

describe("concern routing", () => {
	it("only notifies listeners of the concern that changed", () => {
		const { ui, provider, dispose } = setup();
		const onUsage = vi.fn();
		const onSession = vi.fn();
		ui.subscribe("usage", onUsage);
		ui.subscribe("session", onSession);

		provider.pushUsage();
		expect(onUsage).toHaveBeenCalledTimes(1);
		expect(onSession).not.toHaveBeenCalled();

		provider.pushSession(working());
		expect(onSession).toHaveBeenCalledTimes(1);
		expect(onUsage).toHaveBeenCalledTimes(1);
		dispose();
	});

	it("keeps notifying the remaining listeners when one throws", () => {
		const { ui, provider, dispose } = setup();
		const healthy = vi.fn();
		ui.subscribe("usage", () => {
			throw new Error("bad listener");
		});
		ui.subscribe("usage", healthy);

		expect(() => provider.pushUsage()).not.toThrow();
		expect(healthy).toHaveBeenCalled();
		dispose();
	});
});

describe("elapsed-time tick", () => {
	it("does not run while nothing is subscribed to it", () => {
		vi.useFakeTimers();
		const { provider, dispose } = setup();
		provider.pushSession(working());

		// Nothing watches `tick`, so no timer should have been armed at all.
		expect(vi.getTimerCount()).toBe(0);
		dispose();
	});

	it("does not run while nothing is working", async () => {
		vi.useFakeTimers();
		const { ui, provider, dispose } = setup();
		const onTick = vi.fn();
		ui.subscribe("tick", onTick);
		provider.pushSession({ ...working(), state: "idle" });

		await vi.advanceTimersByTimeAsync(5_000);
		expect(onTick).not.toHaveBeenCalled();
		dispose();
	});

	it("runs while a turn is in flight and someone is watching", async () => {
		vi.useFakeTimers();
		const { ui, provider, dispose } = setup();
		const onTick = vi.fn();
		ui.subscribe("tick", onTick);
		provider.pushSession(working());

		await vi.advanceTimersByTimeAsync(3_000);
		expect(onTick).toHaveBeenCalledTimes(3);
		dispose();
	});

	it("stops again once the turn ends", async () => {
		vi.useFakeTimers();
		const { ui, provider, dispose } = setup();
		const onTick = vi.fn();
		ui.subscribe("tick", onTick);
		provider.pushSession(working());
		await vi.advanceTimersByTimeAsync(2_000);

		provider.pushSession({ ...working(), state: "completed" });
		onTick.mockClear();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(onTick).not.toHaveBeenCalled();
		dispose();
	});

	it("stops when the last tick subscriber goes away", async () => {
		vi.useFakeTimers();
		const { ui, provider, dispose } = setup();
		const onTick = vi.fn();
		const release = ui.subscribe("tick", onTick);
		provider.pushSession(working());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(onTick).toHaveBeenCalledTimes(1);

		release();
		onTick.mockClear();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(onTick).not.toHaveBeenCalled();
		dispose();
	});
});

describe("dashboard data", () => {
	it("honours a pinned window instead of always auto-selecting", () => {
		const { ui, provider, dispose } = setup();
		provider.pushUsage(usageSnapshot());

		expect(ui.dashboardData({ providerId: "codex" }).usage.valueText).toBe("96%");
		expect(
			ui.dashboardData({
				providerId: "codex",
				windowSelection: { mode: "pinned", windowId: "codex.primary" },
			}).usage.valueText,
		).toBe("41%");
		dispose();
	});
});
