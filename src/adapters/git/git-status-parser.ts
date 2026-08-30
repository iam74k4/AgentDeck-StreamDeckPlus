/**
 * Parser for `git status --porcelain=v2 --branch`.
 *
 * Kept free of process handling so the whole of Spike C's parsing surface is
 * unit-testable against fixtures (instructions §12).
 *
 * Porcelain v2 line kinds:
 *   `# branch.*`  header
 *   `1 <XY> …`    ordinary change      `2 <XY> …` rename/copy
 *   `u <XY> …`    unmerged             `? <path>` untracked   `! <path>` ignored
 * where X is the staged state and Y the worktree state; `.` means unchanged.
 */

import type { GitStatus } from "../../domain/git.js";

export function parseGitStatusPorcelainV2(stdout: string, repositoryPath: string): GitStatus {
	const status: GitStatus = {
		repositoryPath,
		detached: false,
		hasCommits: true,
		modified: 0,
		staged: 0,
		untracked: 0,
		conflicted: 0,
		ahead: 0,
		behind: 0,
	};

	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.length === 0) {
			continue;
		}

		if (line.startsWith("# ")) {
			applyHeader(line.slice(2), status);
			continue;
		}

		const kind = line[0];
		if (kind === "?") {
			status.untracked += 1;
			continue;
		}
		if (kind === "!") {
			continue;
		}
		if (kind === "u") {
			status.conflicted += 1;
			continue;
		}
		if (kind === "1" || kind === "2") {
			const xy = line.split(" ")[1] ?? "..";
			const staged = xy[0] ?? ".";
			const worktree = xy[1] ?? ".";
			if (staged !== ".") {
				status.staged += 1;
			}
			if (worktree !== ".") {
				status.modified += 1;
			}
		}
	}

	return status;
}

function applyHeader(header: string, status: GitStatus): void {
	const [key, ...rest] = header.split(" ");
	const value = rest.join(" ").trim();

	switch (key) {
		case "branch.head":
			if (value === "(detached)") {
				status.detached = true;
			} else if (value.length > 0) {
				status.branch = value;
			}
			return;
		case "branch.oid":
			// git reports `(initial)` in place of a sha until the first commit lands.
			if (value === "(initial)") {
				status.hasCommits = false;
			}
			return;
		case "branch.upstream":
			if (value.length > 0) {
				status.upstream = value;
			}
			return;
		case "branch.ab": {
			// Format: `+<ahead> -<behind>`
			const match = /^\+(\d+)\s+-(\d+)$/.exec(value);
			if (match !== null) {
				status.ahead = Number.parseInt(match[1] ?? "0", 10);
				status.behind = Number.parseInt(match[2] ?? "0", 10);
			}
			return;
		}
		default:
			return;
	}
}
