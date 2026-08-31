/**
 * AgentDeck's Claude Code status-line bridge.
 *
 * Claude Code runs whatever `statusLine.command` the user configures, handing it
 * a JSON payload on stdin. That payload is the only documented, credential-free
 * source of Claude's rate-limit percentages, so this bridge captures it for the
 * plugin to read.
 *
 * Two rules shape the implementation:
 *
 *   - It must not take the user's status line away. Pass `--then "<command>"`
 *     and the original command still runs, still receives the same stdin, and
 *     its stdout is still what appears in Claude Code.
 *   - It must never make Claude Code look broken. *Every* path exits 0 with
 *     whatever the chained command produced; a deck that stops updating is a far
 *     smaller problem than a status line that starts erroring.
 *
 * The file is `.mjs` on purpose: the installed `.sdPlugin` folder has no
 * package.json, so a `.js` file is read as CommonJS and fails to load on any
 * Node without ESM syntax detection.
 *
 * Configure it in Claude Code's settings:
 *
 *   "statusLine": {
 *     "type": "command",
 *     "command": "node \"…/com.agentdeck.streamdeck-plus.sdPlugin/bin/statusline.mjs\""
 *   }
 */

import { spawn } from "node:child_process";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDeckDataDir, claudeStatusFilename } from "./providers/claude/bridge-path.js";
import { CLAUDE_BRIDGE_FORMAT, type ClaudeStatusEnvelope } from "./providers/claude/status-payload.js";

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY === true) {
		return "";
	}
	process.stdin.setEncoding("utf8");
	const chunks: string[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as string);
	}
	return chunks.join("");
}

/**
 * Atomic write, so the plugin can never observe a half-written file.
 *
 * One file per session: Claude Code runs the status line in every open session,
 * and a single shared target would have them overwriting each other.
 */
function writeStatus(directory: string, raw: string): void {
	const status = JSON.parse(raw) as ClaudeStatusEnvelope["status"];
	const envelope: ClaudeStatusEnvelope = {
		v: CLAUDE_BRIDGE_FORMAT,
		capturedAt: Date.now(),
		status,
	};

	mkdirSync(directory, { recursive: true });
	const target = join(directory, claudeStatusFilename(status?.session_id ?? undefined));
	const temporary = join(directory, `.claude-status.${process.pid}.tmp`);

	writeFileSync(temporary, JSON.stringify(envelope), "utf8");
	try {
		renameSync(temporary, target);
	} catch (error) {
		// A rename can fail on Windows when an indexer holds the target open.
		// Without this the temp file would be orphaned once per assistant message.
		try {
			unlinkSync(temporary);
		} catch {
			// Nothing further to try.
		}
		throw error;
	}
}

/** Runs the user's original status-line command with the same stdin. */
function runChained(command: string, input: string): Promise<string> {
	return new Promise((resolve) => {
		try {
			const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
			let output = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				output += chunk;
			});
			child.on("error", () => resolve(""));
			child.on("close", () => resolve(output));
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		} catch {
			resolve("");
		}
	});
}

/**
 * Wrapped whole, not per-step: a rejection anywhere here — a broken stdin pipe,
 * a closed stdout — would otherwise surface as an unhandled rejection and a
 * non-zero exit, which is precisely the failure this bridge must never cause.
 */
async function main(): Promise<void> {
	const input = await readStdin().catch(() => "");

	try {
		if (input.trim().length > 0) {
			writeStatus(argValue("--dir") ?? agentDeckDataDir(), input);
		}
	} catch {
		// A capture failure must not reach the user's status line.
	}

	const chained = argValue("--then");
	if (chained !== undefined && chained.length > 0) {
		try {
			process.stdout.write(await runChained(chained, input));
		} catch {
			// A closed stdout is not something the user needs to hear about.
		}
	}
}

try {
	await main();
} catch {
	// Unreachable in practice; the last line of defence for exit code 0.
}
