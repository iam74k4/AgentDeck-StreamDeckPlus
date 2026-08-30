/**
 * The file the Claude Code bridge writes and the provider reads.
 *
 * Shared by both entry points, so the two halves can never disagree about where
 * the hand-off happens.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const CLAUDE_STATUS_FILENAME = "claude-status.json";

/**
 * Resolves AgentDeck's data directory.
 *
 * Windows is the MVP target, so `%LOCALAPPDATA%` is preferred there; elsewhere a
 * dot-directory under the home directory, falling back to the temp directory
 * when there is no home to write to.
 */
export function agentDeckDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const localAppData = env.LOCALAPPDATA;
	if (typeof localAppData === "string" && localAppData.length > 0) {
		return join(localAppData, "AgentDeck");
	}
	const home = homedir();
	return home.length > 0 ? join(home, ".agentdeck") : join(tmpdir(), "agentdeck");
}

export function claudeStatusPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDeckDataDir(env), CLAUDE_STATUS_FILENAME);
}
