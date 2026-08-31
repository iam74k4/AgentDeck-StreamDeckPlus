/**
 * A runtime wired from the real services, backed by a controllable provider and
 * git adapter, so action-layer tests exercise real wiring rather than mocks of it.
 */

import { GitService } from "@/application/git-service.js";
import { ProjectService, type ProjectState, type ProjectStore } from "@/application/project-service.js";
import { ApprovalService } from "@/application/approval-service.js";
import { ModelService } from "@/application/model-service.js";
import { PromptService } from "@/application/prompt-service.js";
import { VoiceService } from "@/application/voice-service.js";
import { ProviderRegistry } from "@/application/provider-registry.js";
import { SessionService } from "@/application/session-service.js";
import { UsageService } from "@/application/usage-service.js";
import type { Clipboard } from "@/adapters/desktop/clipboard.js";
import type { ScreenshotCapture } from "@/adapters/desktop/screenshot.js";
import type { VoiceInputProvider } from "@/adapters/desktop/voice.js";
import type { GitAdapter } from "@/adapters/git/git-adapter.js";
import { LauncherRegistry, type AppLauncher } from "@/adapters/launcher/app-launcher.js";
import type { ApprovalDecision, ApprovalRequest } from "@/domain/approval.js";
import type { GitStatus } from "@/domain/git.js";
import type { ModelDescriptor, ModelSelection } from "@/domain/model.js";
import type { ProviderEvent, ProviderEventListener } from "@/domain/provider-events.js";
import type { AgentSession } from "@/domain/session.js";
import type { UsageSnapshot } from "@/domain/usage.js";
import { createLogger, nullSink } from "@/infrastructure/logger.js";
import { PlusDashboardCoordinator } from "@/presentation/plus-dashboard-coordinator.js";
import { UiCoordinator } from "@/presentation/ui-coordinator.js";
import type { AgentInput, AgentProvider } from "@/providers/provider.js";
import { DASHBOARD_CONCERNS, type AgentDeckRuntime, type DashboardContext } from "@/runtime.js";

export class ControllableProvider implements AgentProvider {
	public readonly id = "codex";
	public readonly displayName = "Codex";
	public interrupted: string[] = [];
	public readonly answered: { id: string; decision: ApprovalDecision }[] = [];
	public readonly applied: { sessionId: string; selection: ModelSelection }[] = [];
	public readonly steered: { sessionId: string; input: AgentInput }[] = [];
	public readonly startedSessions: { cwd?: string }[] = [];
	/** Set to make `steer` reject, standing in for a provider that went away. */
	public steerFails = false;
	public models: ModelDescriptor[] = [
		{ id: "gpt-5.1-codex", label: "GPT-5.1 Codex", reasoningLevels: ["medium", "high"] },
		{ id: "gpt-5.1", label: "GPT-5.1" },
	];
	/** Set to make `getModels` reject, standing in for an offline provider. */
	public modelsFail = false;
	readonly #listeners = new Set<ProviderEventListener>();

	public async isAvailable(): Promise<boolean> {
		return true;
	}
	public async start(): Promise<void> {}
	public async stop(): Promise<void> {}
	public async listSessions(): Promise<AgentSession[]> {
		return [];
	}
	public async interrupt(sessionId: string): Promise<void> {
		this.interrupted.push(sessionId);
	}
	public async refreshUsage(): Promise<UsageSnapshot> {
		return usageSnapshot();
	}

	public async getModels(): Promise<ModelDescriptor[]> {
		if (this.modelsFail) {
			throw new Error("model/list unavailable");
		}
		return this.models;
	}

	public async applyModel(sessionId: string, selection: ModelSelection): Promise<void> {
		this.applied.push({ sessionId, selection });
	}

	public async steer(sessionId: string, input: AgentInput): Promise<void> {
		if (this.steerFails) {
			throw new Error("provider went away");
		}
		this.steered.push({ sessionId, input });
	}

	public async startSession(options: { cwd?: string } = {}): Promise<AgentSession> {
		this.startedSessions.push(options);
		const session: AgentSession = {
			id: "thr_new",
			providerId: this.id,
			state: "idle",
			updatedAt: new Date(),
		};
		this.emit({ type: "session-updated", session });
		return session;
	}

	public async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
		this.answered.push({ id: approvalId, decision });
		this.emit({ type: "approval-resolved", approvalId });
	}

	public subscribe(listener: ProviderEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public emit(event: ProviderEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}

	public pushUsage(snapshot: UsageSnapshot = usageSnapshot()): void {
		this.emit({ type: "usage-updated", snapshot });
	}

	public pushSession(session: AgentSession): void {
		this.emit({ type: "session-updated", session });
	}

	public pushApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
		const request: ApprovalRequest = {
			id: "req_1",
			sessionId: "thr_1",
			type: "command",
			title: "npm test",
			summary: "",
			risk: "low",
			...overrides,
		};
		this.emit({ type: "approval-requested", request });
		return request;
	}
}

export function usageSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		providerId: "codex",
		status: "ready",
		fetchedAt: new Date(0),
		windows: [
			{ id: "codex.primary", label: "5h", usedPercent: 41 },
			{ id: "codex.secondary", label: "7d", usedPercent: 96 },
		],
		...overrides,
	};
}

export function gitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
	return {
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
		...overrides,
	};
}

export interface FakeRuntime {
	runtime: AgentDeckRuntime;
	provider: ControllableProvider;
	contexts: DashboardContext[];
	launched: string[];
	/** What the fake desktop handed over, and what it was asked to do. */
	captured: {
		clipboard: string;
		selection: string;
		written: string[];
		captures: string[];
		liveShots: Set<string>;
		transcript: string;
		recording: boolean;
	};
}

/** Keeps persisted project state in memory for tests. */
export function memoryProjectStore(initial: ProjectState = { projects: [] }): ProjectStore {
	let state = initial;
	return {
		load: async () => state,
		save: async (next) => {
			state = next;
		},
	};
}

export function createFakeRuntime(
	options: { git?: GitAdapter; projectStore?: ProjectStore } = {},
): FakeRuntime {
	const logger = createLogger({ sink: nullSink });
	const registry = new ProviderRegistry(logger);
	const provider = new ControllableProvider();
	registry.register(provider);

	const usage = new UsageService(registry, { manualRefreshThrottleMs: 0 });
	const sessions = new SessionService(registry);
	const git = new GitService(
		options.git ?? {
			isRepository: async () => true,
			getStatus: async (path) => gitStatus({ repositoryPath: path }),
		},
		{ pollIntervalMs: 600_000 },
	);

	const projects = new ProjectService({
		store: options.projectStore ?? memoryProjectStore(),
		// Tests assert on registration, not on the developer's filesystem.
		stat: async () => ({ exists: true, isDirectory: true }),
		idFactory: (() => {
			let n = 0;
			return () => `prj_${++n}`;
		})(),
	});

	const launched: string[] = [];
	const captured = {
		clipboard: "copied text",
		selection: "selected text",
		written: [] as string[],
		captures: [] as string[],
		/** Screenshot files not yet disposed; design §22.4 wants this empty. */
		liveShots: new Set<string>(),
		transcript: "check the parser",
		recording: false,
	};

	const launchers = new LauncherRegistry({
		create: (definition): AppLauncher => ({
			id: definition.id,
			displayName: definition.displayName,
			isInstalled: async () => definition.command !== "missing",
			launch: async (context) => {
				if (definition.command === "missing") {
					throw new Error("not installed");
				}
				launched.push(`${definition.id}:${context?.projectPath ?? ""}`);
			},
		}),
	});

	const approvals = new ApprovalService(registry);
	// Stand-ins for the desktop: no display, no clipboard, no microphone in CI.
	const clipboard: Clipboard = {
		read: async () => captured.clipboard,
		readSelection: async () => captured.selection,
	};
	const screenshot: ScreenshotCapture = {
		capture: async (mode) => {
			captured.captures.push(mode);
			const path = `/tmp/agentdeck-fake-${captured.captures.length}.png`;
			captured.liveShots.add(path);
			return { path, dispose: async () => void captured.liveShots.delete(path) };
		},
	};
	const writeClipboard = async (text: string): Promise<void> => {
		captured.written.push(text);
	};
	const voiceProvider: VoiceInputProvider = {
		displayName: "Fake microphone",
		get recording() {
			return captured.recording;
		},
		start: async () => {
			captured.recording = true;
		},
		stop: async () => {
			captured.recording = false;
			return { text: captured.transcript, durationMs: 1_200 };
		},
	};
	const models = new ModelService(registry, sessions);
	const prompts = new PromptService(sessions, { clipboard, screenshot, writeClipboard });
	const voice = new VoiceService(prompts, { provider: voiceProvider });

	const ui = new UiCoordinator({
		registry,
		usage,
		sessions,
		git,
		projects,
		approvals,
		models,
		prompts,
		voice,
	});
	const contexts: DashboardContext[] = [];
	let dashboardContext: DashboardContext = {};

	const dashboard = new PlusDashboardCoordinator();
	const refreshDashboard = (): void => {
		dashboard.update(
			ui.dashboardData({
				providerId: dashboardContext.providerId ?? "codex",
				...(dashboardContext.repositoryPath === undefined
					? {}
					: { repositoryPath: dashboardContext.repositoryPath }),
				...(dashboardContext.windowSelection === undefined
					? {}
					: { windowSelection: dashboardContext.windowSelection }),
			}),
		);
	};

	// The same wiring the plugin uses, so an action test notices a segment that
	// stops repainting.
	for (const concern of DASHBOARD_CONCERNS) {
		ui.subscribe(concern, refreshDashboard);
	}

	const runtime: AgentDeckRuntime = {
		logger,
		registry,
		usage,
		sessions,
		git,
		projects,
		approvals,
		models,
		prompts,
		voice,
		launchers,
		ui,
		dashboard,
		defaultProviderId: "codex",
		setDashboardContext(context: DashboardContext): void {
			dashboardContext = { ...dashboardContext, ...context };
			contexts.push({ ...dashboardContext });
			refreshDashboard();
		},
		refreshDashboard,
		async start(): Promise<void> {
			await projects.load();
		},
		async stop(): Promise<void> {
			ui.dispose();
			projects.dispose();
			git.dispose();
			sessions.dispose();
			usage.dispose();
		},
	};

	return { runtime, provider, contexts, launched, captured };
}
