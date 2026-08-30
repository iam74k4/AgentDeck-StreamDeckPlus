/**
 * Git view model — design §16.1.
 */

import { errorBadge } from "../../domain/errors.js";
import { branchLabel } from "../../domain/git.js";
import type { GitStatusEntry } from "../../application/git-service.js";
import { Palette } from "./colors.js";

export interface GitViewModel {
	branch: string;
	summary: string;
	detail: string;
	color: string;
	available: boolean;
}

export function buildGitViewModel(entry: GitStatusEntry | undefined): GitViewModel {
	if (entry === undefined) {
		return { branch: "…", summary: "", detail: "", color: Palette.idle, available: false };
	}
	if (entry.status === undefined) {
		const badge = entry.errorCode === undefined ? "ERROR" : errorBadge(entry.errorCode);
		return { branch: badge, summary: "", detail: "", color: Palette.danger, available: false };
	}

	const status = entry.status;
	const dirty = status.modified + status.staged + status.untracked + status.conflicted;

	return {
		branch: branchLabel(status),
		summary: `M:${status.modified} S:${status.staged} U:${status.untracked}`,
		// Ahead/behind means nothing before the first commit (design §16.1).
		detail: status.hasCommits ? `↑${status.ahead} ↓${status.behind}` : "no commits",
		color: status.conflicted > 0 ? Palette.danger : dirty > 0 ? Palette.warn : Palette.ok,
		available: true,
	};
}
