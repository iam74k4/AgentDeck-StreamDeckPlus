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
import { PromptService } from "./application/prompt-service.js";
import { VoiceService } from "./application/voice-service.js";
import type { Unsubscribe } from "./domain/provider-events.js";
import { ProjectService, type PathStat, type ProjectStore } from "./application/project-service.js";
import { ProviderRegistry } from "./application/provider-registry.js";
import { SessionService } from "./application/session-service.js";
import { UsageService } from "./application/usage-service.js";
import { GitCliAdapter } from "./adapters/git/git-adapter.js";
import { LauncherRegistry } from "./adapters/launcher/app-launcher.js";
import { WindowsClipboard } from "./adapters/desktop/clipboard.js";
import { WindowsScreenshot } from "./adapters/desktop/screenshot.js";
import { SystemSpeechVoiceProvider } from "./adapters/desktop/voice.js";
import type { Clipboard } from "./adapters/desktop/clipboard.js";
import type { ScreenshotCapture } from "./adapters/desktop/screenshot.js";
import type { VoiceInputProvider } from "./adapters/desktop/voice.js";
import type { WindowSelection } from "./domain/usage.js";
import type { Logger } from "./infrastructure/logger.js";
import { PlusDashboardCoordinator } from "./presentation/plus-dashboard-coordinator.js";
import { UiCoordinator, type UiConcern } from "./presentation/ui-coordinator.js";
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
/**
 * Concerns that repaint the touch strip.
 *
 * `tick` is deliberately absent: it is subscribed only while an encoder is
 * placed (design §20.2). Exported so tests drive the same wiring the plugin
 * does — a segment that stops updating is the defect this list guards against.
 */
export const DASHBOARD_CONCERNS = [
	"usage",
	"session",
	"git",
	"project",
	"provider",
	"model",
	"prompt",
	"voice",
] as const satisfies readonly UiConcern[];

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
	readonly prompts: PromptService;
	readonly voice: VoiceService;
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
	/** Test seams for the desktop adapters (design §15). */
	clipboard?: Clipboard;
	screenshot?: ScreenshotCapture;
	voice?: VoiceInputProvider;
	writeClipboard?: (text: string) => Promise<void>;
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

	// Desktop capture is Windows-only (design §2). The adapters are constructed
	// everywhere and report NOT_CONFIGURED off Windows, so a key says SETUP
	// instead of the plugin refusing to start.
	const clipboard = options.clipboard ?? new WindowsClipboard({ logger });
	const screenshot = options.screenshot ?? new WindowsScreenshot({ logger });
	const prompts = new PromptService(sessions, {
		logger,
		clipboard,
		screenshot,
		writeClipboard: options.writeClipboard,
	});
	// Design §22.3 — local recognition only; there is no remote STT to disclose.
	const voice = new VoiceService(prompts, {
		logger,
		provider: options.voice ?? new SystemSpeechVoiceProvider({ logger }),
	});

	const ui = new UiCoordinator(
		{ registry, usage, sessions, git, projects, approvals, models, prompts, voice },
		{ logger },
	);

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

	// Keep the touch strip in step with every concern the dashboard shows.
	for (const concern of DASHBOARD_CONCERNS) {
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
		prompts,
		voice,
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
			// Awaited, not fired and forgotten: the recogniser is a child process
			// holding the microphone, and `process.exit` follows this closely enough
			// that an unawaited shutdown can leave it running.
			await voice.cancel();
			voice.dispose();
			prompts.dispose();
			models.dispose();
			approvals.dispose();
			git.dispose();
			sessions.dispose();
			usage.dispose();
			await registry.stopAll();
		},
	};
}
