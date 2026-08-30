/**
 * Git domain model — design §16.
 *
 * Git is a core, provider-independent capability.
 */

export interface GitStatus {
	repositoryPath: string;
	branch?: string;
	/** True while the repository has no commits yet, or HEAD is detached. */
	detached: boolean;
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
	const branch = status.branch ?? (status.detached ? "detached" : "--");
	return [
		branch,
		`M:${status.modified}`,
		`S:${status.staged}`,
		`U:${status.untracked}`,
		`↑${status.ahead} ↓${status.behind}`,
	].join(" | ");
}

/** Short form for a 200x100 encoder segment or a key subtitle. */
export function formatGitCompact(status: GitStatus): string {
	const branch = status.branch ?? (status.detached ? "detached" : "--");
	return `${branch} M:${status.modified}`;
}
