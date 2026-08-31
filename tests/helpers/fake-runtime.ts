/**
 * A runtime wired from the real services, backed by a controllable provider and
 * git adapter, so action-layer tests exercise real wiring rather than mocks of it.
 */

import { GitService } from "@/application/git-service.js";
import { ProjectService, type ProjectState, type ProjectStore } from "@/application/project-service.js";
import { ProviderRegistry } from "@/application/provider-registry.js";
import { SessionService } from "@/application/session-service.js";
import { UsageService } from "@/application/usage-service.js";
import type { GitAdapter } from "@/adapters/git/git-adapter.js";
import { LauncherRegistry, type AppLauncher } from "@/adapters/launcher/app-launcher.js";
import type { GitStatus } from "@/domain/git.js";
import type { ProviderEvent, ProviderEventListener } from "@/domain/provider-events.js";
import type { AgentSession } from "@/domain/session.js";
import type { UsageSnapshot } from "@/domain/usage.js";
import { createLogger, nullSink } from "@/infrastructure/logger.js";
import { PlusDashboardCoordinator } from "@/presentation/plus-dashboard-coordinator.js";
import { UiCoordinator } from "@/presentation/ui-coordinator.js";
import type { AgentProvider } from "@/providers/provider.js";
import type { AgentDeckRuntime, DashboardContext } from "@/runtime.js";

export class ControllableProvider implements AgentProvider {
	public readonly id = "codex";
	public readonly displayName = "Codex";
	public interrupted: string[] = [];
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

	const ui = new UiCoordinator({ registry, usage, sessions, git, projects });
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

	const runtime: AgentDeckRuntime = {
		logger,
		registry,
		usage,
		sessions,
		git,
		projects,
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

	return { runtime, provider, contexts, launched };
}
