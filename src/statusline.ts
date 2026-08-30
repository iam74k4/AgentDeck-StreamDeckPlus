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
 *   - It must never make Claude Code look broken. Every failure path exits 0
 *     with whatever the chained command produced; a deck that stops updating is
 *     a far smaller problem than a status line that starts erroring.
 *
 * Configure it in Claude Code's settings:
 *
 *   "statusLine": {
 *     "type": "command",
 *     "command": "node \"…/com.agentdeck.streamdeck-plus.sdPlugin/bin/statusline.js\""
 *   }
 */

import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeStatusPath } from "./providers/claude/bridge-path.js";
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

/** Atomic write, so the plugin can never observe a half-written file. */
function writeStatus(target: string, raw: string): void {
	const status: unknown = JSON.parse(raw);
	const envelope: ClaudeStatusEnvelope = {
		v: CLAUDE_BRIDGE_FORMAT,
		capturedAt: Date.now(),
		status: status as ClaudeStatusEnvelope["status"],
	};

	const directory = dirname(target);
	mkdirSync(directory, { recursive: true });
	const temporary = join(directory, `.claude-status.${process.pid}.tmp`);
	writeFileSync(temporary, JSON.stringify(envelope), "utf8");
	renameSync(temporary, target);
}

/** Runs the user's original status-line command with the same stdin. */
function runChained(command: string, input: string): Promise<string> {
	return new Promise((resolve) => {
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
	});
}

const input = await readStdin();
const target = argValue("--out") ?? claudeStatusPath();

try {
	if (input.trim().length > 0) {
		writeStatus(target, input);
	}
} catch {
	// Never surface a bridge failure into the user's status line.
}

const chained = argValue("--then");
if (chained !== undefined && chained.length > 0) {
	process.stdout.write(await runChained(chained, input));
}
