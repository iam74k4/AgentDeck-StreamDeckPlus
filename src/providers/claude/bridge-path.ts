/**
 * Where the Claude Code bridge writes and the provider reads.
 *
 * Shared by both entry points so the two halves can never disagree about the
 * hand-off location.
 *
 * Files are per session, not one shared file: Claude Code runs the status line
 * once per assistant message in *every* open session, and a single target would
 * mean two terminals overwriting each other — the deck would flap between them
 * and attribute one session's usage to the other.
 */

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "claude-status";
const SUFFIX = ".json";

/**
 * Resolves AgentDeck's data directory.
 *
 * `%LOCALAPPDATA%` is used on Windows only. Honouring it elsewhere would let a
 * stray export in a shell profile send the bridge somewhere the Stream Deck app
 * — launched from the GUI without that variable — would never look.
 */
export function agentDeckDataDir(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === "win32") {
		const localAppData = env.LOCALAPPDATA;
		if (typeof localAppData === "string" && localAppData.length > 0) {
			return join(localAppData, "AgentDeck");
		}
	}
	const home = homedir();
	return home.length > 0 ? join(home, ".agentdeck") : join(tmpdir(), "agentdeck");
}

/** Filename for one session's reading. */
export function claudeStatusFilename(sessionId: string | undefined): string {
	const safe = sanitiseSessionId(sessionId);
	return safe === undefined ? `${PREFIX}${SUFFIX}` : `${PREFIX}.${safe}${SUFFIX}`;
}

export function isClaudeStatusFilename(name: string): boolean {
	return name.startsWith(`${PREFIX}`) && name.endsWith(SUFFIX);
}

/**
 * A session id reaches us from Claude Code, so it is treated as untrusted input
 * and reduced to characters that cannot escape the directory.
 */
function sanitiseSessionId(sessionId: string | undefined): string | undefined {
	if (typeof sessionId !== "string") {
		return undefined;
	}
	const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
	return safe.length === 0 ? undefined : safe;
}
