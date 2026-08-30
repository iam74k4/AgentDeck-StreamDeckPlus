/**
 * Git domain model — design §16.
 *
 * Git is a core, provider-independent capability.
 */

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
