/**
 * Git domain model — design §16.
 *
 * Git is a core, provider-independent capability.
 */

/**
 * Design §16.2 — the deck shows the shape of a change, never the change.
 *
 * ```text
 * +183
 * -42
 * 7 files
 * ```
 *
 * Lives here rather than beside `AgentSession` because it is a property of a
 * working tree: git can produce one without any agent involved, which is exactly
 * how the deck gets it.
 */
export interface DiffSummary {
	added: number;
	removed: number;
	fileCount: number;
	/** Files whose line counts git could not report, e.g. binaries. */
	binaryFileCount?: number;
}

export interface GitStatus {
	repositoryPath: string;
	branch?: string;
	/** True only while HEAD is detached. A fresh repository still has a branch. */
	detached: boolean;
	/** False for a repository that has been `git init`ed but has no commits yet. */
	hasCommits: boolean;
	modified: number;
	staged: number;
	untracked: number;
	conflicted: number;
	ahead: number;
	behind: number;
	upstream?: string;
	/** Tracked changes against HEAD; absent when git could not report them. */
	diff?: DiffSummary;
}

/** Design §16.1 — `main | M:4 | S:2 | U:1 | ↑1 ↓0` */
export function formatGitSummary(status: GitStatus): string {
	const parts = [branchLabel(status), `M:${status.modified}`, `S:${status.staged}`, `U:${status.untracked}`];
	// Ahead/behind is meaningless before the first commit, so it is left off.
	if (status.hasCommits) {
		parts.push(`↑${status.ahead} ↓${status.behind}`);
	}
	return parts.join(" | ");
}

export function branchLabel(status: GitStatus): string {
	return status.branch ?? (status.detached ? "detached" : "--");
}

/** Short form for a 200x100 encoder segment or a key subtitle. */
export function formatGitCompact(status: GitStatus): string {
	return `${branchLabel(status)} M:${status.modified}`;
}

/** Design §16.2 — `+183 -42 · 7 files`, or an empty string with nothing to show. */
export function formatDiffSummary(diff: DiffSummary | undefined): string {
	if (diff === undefined || diff.fileCount === 0) {
		return "";
	}
	const files = `${diff.fileCount} file${diff.fileCount === 1 ? "" : "s"}`;
	return `+${diff.added} -${diff.removed} · ${files}`;
}

export function isEmptyDiff(diff: DiffSummary | undefined): boolean {
	return diff === undefined || diff.fileCount === 0;
}

/**
 * Parses `git diff --numstat`.
 *
 * Binary files report `-` for both counts rather than a number; they are counted
 * as changed files but contribute no lines, which is what git itself does.
 */
export function parseGitNumstat(output: string): DiffSummary {
	let added = 0;
	let removed = 0;
	let fileCount = 0;
	let binaryFileCount = 0;

	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}
		const [addedField, removedField] = trimmed.split("\t");
		if (addedField === undefined || removedField === undefined) {
			continue;
		}
		fileCount += 1;
		if (addedField === "-" || removedField === "-") {
			binaryFileCount += 1;
			continue;
		}
		const addedLines = Number.parseInt(addedField, 10);
		const removedLines = Number.parseInt(removedField, 10);
		if (Number.isNaN(addedLines) || Number.isNaN(removedLines)) {
			// A line that is not numstat at all is not a file.
			fileCount -= 1;
			continue;
		}
		added += addedLines;
		removed += removedLines;
	}

	return { added, removed, fileCount, ...(binaryFileCount === 0 ? {} : { binaryFileCount }) };
}
