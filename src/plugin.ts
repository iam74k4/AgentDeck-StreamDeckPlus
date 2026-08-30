/**
 * AgentDeck plugin entry point.
 *
 * Registers the Stream Deck actions, wires the runtime, and keeps the plugin
 * alive through provider failures (design §27, instructions §7.5).
 */

import streamDeck from "@elgato/streamdeck";
import { AgentStatusAction } from "./actions/agent-status-action.js";
import { DashboardEncoderAction } from "./actions/dashboard-encoder-action.js";
import { GitAction } from "./actions/git-action.js";
import { StopAction } from "./actions/stop-action.js";
import type { SettingsValue } from "./actions/settings.js";
import { UsageAction } from "./actions/usage-action.js";
import { createLogger, type LogLevel as AgentDeckLogLevel, type LogSink } from "./infrastructure/logger.js";
import { ClaudeProvider } from "./providers/claude/claude-provider.js";
import { CodexProvider } from "./providers/codex/codex-provider.js";
import { createRuntime } from "./runtime.js";

/**
 * Global settings — design §23.1. Credentials are never among them (§22.1).
 *
 * Intervals are lower-bounded by the services that consume them; a Property
 * Inspector `min` attribute is not enforced when JavaScript reads `value`.
 */
interface AgentDeckGlobalSettings {
	codexExecutable?: string;
	codexHealthCheckIntervalMs?: number;
	claudeRefreshIntervalMs?: number;
	gitPollIntervalMs?: number;
	debugLogging?: boolean;
	[key: string]: SettingsValue;
}

/** Bridges the plugin's redacting logger onto the Stream Deck log file. */
const sink: LogSink = {
	error: (message) => streamDeck.logger.error(message),
	warn: (message) => streamDeck.logger.warn(message),
	info: (message) => streamDeck.logger.info(message),
	debug: (message) => streamDeck.logger.debug(message),
};

const logger = createLogger({ sink, level: "info", scope: "agentdeck" });
const runtime = createRuntime({ logger });

streamDeck.actions.registerAction(new AgentStatusAction(runtime));
streamDeck.actions.registerAction(new StopAction(runtime));
streamDeck.actions.registerAction(new UsageAction(runtime));
streamDeck.actions.registerAction(new GitAction(runtime));
streamDeck.actions.registerAction(new DashboardEncoderAction(runtime));

streamDeck.settings.onDidReceiveGlobalSettings<AgentDeckGlobalSettings>((ev) => {
	void applyGlobalSettings(ev.settings);
});

async function applyGlobalSettings(settings: AgentDeckGlobalSettings): Promise<void> {
	const level: AgentDeckLogLevel = settings.debugLogging === true ? "debug" : "info";
	logger.setLevel(level);
	streamDeck.logger.setLevel(level);

	runtime.git.setPollInterval(
		typeof settings.gitPollIntervalMs === "number" ? settings.gitPollIntervalMs : undefined,
	);

	const claude = runtime.registry.get("claude");
	if (claude instanceof ClaudeProvider) {
		claude.configure({
			...(typeof settings.claudeRefreshIntervalMs === "number"
				? { refreshIntervalMs: settings.claudeRefreshIntervalMs }
				: {}),
		});
	}

	const provider = runtime.registry.get(runtime.defaultProviderId);
	if (provider instanceof CodexProvider) {
		await provider.configure({
			...(typeof settings.codexExecutable === "string" && settings.codexExecutable.length > 0
				? { executable: settings.codexExecutable }
				: {}),
			...(typeof settings.codexHealthCheckIntervalMs === "number"
				? { healthCheckIntervalMs: settings.codexHealthCheckIntervalMs }
				: {}),
		});
	}
}

// A provider crash must never take the plugin down with it.
process.on("uncaughtException", (error) => {
	logger.error("uncaught exception", error);
});
process.on("unhandledRejection", (reason) => {
	logger.error("unhandled rejection", reason);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void runtime.stop().finally(() => process.exit(0));
	});
}

await streamDeck.connect();

try {
	const settings = await streamDeck.settings.getGlobalSettings<AgentDeckGlobalSettings>();
	await applyGlobalSettings(settings);
} catch (error) {
	logger.warn("failed to read global settings", error);
}

await runtime.start();
logger.info("AgentDeck started");
