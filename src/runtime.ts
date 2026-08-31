/**
 * Composition root.
 *
 * Wires the layers in the direction design §8 requires: providers and adapters are
 * constructed here and injected downwards, so nothing in `domain/` or
 * `application/` ever names a concrete implementation.
 */

import { ApprovalService } from "./application/approval-service.js";
import { GitService } from "./application/git-service.js";
import { ModelService } from "./application/model-service.js";
import type { Unsubscribe } from "./domain/provider-events.js";
import { ProjectService, type PathStat, type ProjectStore } from "./application/project-service.js";
import { ProviderRegistry } from "./application/provider-registry.js";
import { SessionService } from "./application/session-service.js";
import { UsageService } from "./application/usage-service.js";
import { GitCliAdapter } from "./adapters/git/git-adapter.js";
import { LauncherRegistry } from "./adapters/launcher/app-launcher.js";
import type { WindowSelection } from "./domain/usage.js";
import type { Logger } from "./infrastructure/logger.js";
import { PlusDashboardCoordinator } from "./presentation/plus-dashboard-coordinator.js";
import { UiCoordinator } from "./presentation/ui-coordinator.js";
import { ClaudeProvider, type ClaudeProviderOptions } from "./providers/claude/claude-provider.js";
import {
	CodexProvider,
	CODEX_PROVIDER_ID,
	type CodexProviderOptions,
} from "./providers/codex/codex-provider.js";

/**
 * What the touch strip is currently pointed at.
 *
 * The provider and repository come from encoder action settings, so the runtime
 * has to be told; otherwise a background redraw would blank the git segment.
 */
export interface DashboardContext {
	providerId?: string;
	repositoryPath?: string;
	windowSelection?: WindowSelection;
}

export interface AgentDeckRuntime {
	readonly logger: Logger;
	readonly registry: ProviderRegistry;
	readonly usage: UsageService;
	readonly sessions: SessionService;
	readonly git: GitService;
	readonly projects: ProjectService;
	readonly approvals: ApprovalService;
	readonly models: ModelService;
	readonly launchers: LauncherRegistry;
	readonly ui: UiCoordinator;
	readonly dashboard: PlusDashboardCoordinator;
	readonly defaultProviderId: string;
	/** Called by encoder actions as their settings change. */
	setDashboardContext(context: DashboardContext): void;
	refreshDashboard(): void;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface RuntimeOptions {
	logger: Logger;
	/** Where registered projects are persisted; injected so the layer stays clean. */
	projectStore: ProjectStore;
	projectStat?: PathStat;
	codex?: CodexProviderOptions;
	claude?: ClaudeProviderOptions;
	gitExecutable?: string;
	gitPollIntervalMs?: number;
}

export function createRuntime(options: RuntimeOptions): AgentDeckRuntime {
	const logger = options.logger;

	const registry = new ProviderRegistry(logger);
	registry.register(new CodexProvider({ logger, ...options.codex }));
	// Monitoring only: Claude Code reports usage but offers no control channel,
	// so ClaudeProvider implements neither `interrupt` nor `steer` (design §10).
	registry.register(new ClaudeProvider({ logger, ...options.claude }));

	const usage = new UsageService(registry, { logger });
	const sessions = new SessionService(registry, { logger });
	const git = new GitService(
		new GitCliAdapter({
			logger,
			...(options.gitExecutable === undefined ? {} : { executable: options.gitExecutable }),
		}),
		{
			logger,
			...(options.gitPollIntervalMs === undefined ? {} : { pollIntervalMs: options.gitPollIntervalMs }),
		},
	);

	const projects = new ProjectService({
		store: options.projectStore,
		logger,
		...(options.projectStat === undefined ? {} : { stat: options.projectStat }),
	});
	const launchers = new LauncherRegistry({ logger });
	const approvals = new ApprovalService(registry, { logger });
	const models = new ModelService(registry, sessions, { logger });

	const ui = new UiCoordinator({ registry, usage, sessions, git, projects, approvals, models }, { logger });

	// The elapsed-time tick exists for the touch strip; with no encoder placed,
	// nothing here should keep a 1 Hz timer alive (design §20.2).
	let releaseTick: Unsubscribe | undefined;
	const dashboard = new PlusDashboardCoordinator({
		onError: (error) => logger.warn("failed to update touch strip", error),
		onOccupancyChange: (occupied) => {
			if (occupied) {
				releaseTick ??= ui.subscribe("tick", () => refreshDashboard());
				return;
			}
			releaseTick?.();
			releaseTick = undefined;
		},
	});

	// Design §16.3: an agent event is a better git refresh trigger than a timer.
	// Only the working → not-working transition counts. Firing on every
	// session-updated would spawn a git process per event, and a provider that
	// re-reports an idle session on each poll would do so continuously.
	const wasWorking = new Set<string>();
	registry.subscribe((event) => {
		if (event.type !== "session-updated") {
			return;
		}
		const key = `${event.session.providerId}::${event.session.id}`;
		if (event.session.state === "working") {
			wasWorking.add(key);
			return;
		}
		if (wasWorking.delete(key)) {
			git.refreshWatched();
		}
	});

	let dashboardContext: DashboardContext = {};
	function refreshDashboard(): void {
		dashboard.update(
			ui.dashboardData({
				providerId: dashboardContext.providerId ?? CODEX_PROVIDER_ID,
				...(dashboardContext.repositoryPath === undefined
					? {}
					: { repositoryPath: dashboardContext.repositoryPath }),
				...(dashboardContext.windowSelection === undefined
					? {}
					: { windowSelection: dashboardContext.windowSelection }),
			}),
		);
	}

	// Keep the touch strip in step with every concern the dashboard shows. `tick`
	// is deliberately absent: it is subscribed only while an encoder is placed.
	for (const concern of ["usage", "session", "git", "project", "provider", "model"] as const) {
		ui.subscribe(concern, refreshDashboard);
	}

	return {
		logger,
		registry,
		usage,
		sessions,
		git,
		projects,
		approvals,
		models,
		launchers,
		ui,
		dashboard,
		defaultProviderId: CODEX_PROVIDER_ID,
		setDashboardContext(context: DashboardContext): void {
			dashboardContext = { ...dashboardContext, ...context };
			refreshDashboard();
		},
		refreshDashboard,
		async start(): Promise<void> {
			await projects.load();
			// The active project is the repository the git segment watches.
			const activePath = projects.getActive()?.path;
			if (activePath !== undefined) {
				git.watch(activePath);
			}
			projects.subscribe((state) => {
				const path = state.projects.find((project) => project.id === state.activeProjectId)?.path;
				if (path !== undefined) {
					git.watch(path);
				}
			});

			const results = await registry.startAll();
			for (const result of results) {
				if (!result.started) {
					logger.warn(`provider ${result.providerId} did not start`, result.error);
				}
			}
		},
		async stop(): Promise<void> {
			releaseTick?.();
			releaseTick = undefined;
			ui.dispose();
			projects.dispose();
			models.dispose();
			approvals.dispose();
			git.dispose();
			sessions.dispose();
			usage.dispose();
			await registry.stopAll();
		},
	};
}
