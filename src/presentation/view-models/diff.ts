/**
 * Diff summary view model — design §16.2.
 *
 * ```text
 * +183
 * -42
 * 7 files
 * ```
 *
 * The counts, never the change. Reading a diff belongs in the editor; the deck
 * answers "how big is this" at a glance (design §3.5).
 */

import type { GitStatusEntry } from "../../application/git-service.js";
import { errorBadge } from "../../domain/errors.js";
import { hasChanges } from "../../domain/git.js";
import { Palette } from "./colors.js";

export interface DiffViewModel {
	/** `+183` */
	added: string;
	/** `-42` */
	removed: string;
	/** `7 files`, or why there is nothing to show. */
	detail: string;
	color: string;
	available: boolean;
}

/** Enough churn that it is worth a second look before the next turn. */
const LARGE_CHANGE_FILES = 20;

export function buildDiffViewModel(entry: GitStatusEntry | undefined): DiffViewModel {
	if (entry === undefined) {
		return { added: "…", removed: "", detail: "", color: Palette.idle, available: false };
	}
	if (entry.status === undefined) {
		const badge = entry.errorCode === undefined ? "ERROR" : errorBadge(entry.errorCode);
		return { added: badge, removed: "", detail: "", color: Palette.danger, available: false };
	}

	const diff = entry.status.diff;
	if (!hasChanges(diff)) {
		// A clean tree and a diff git could not read are different things, and the
		// deck should not let them look the same.
		return {
			added: "+0",
			removed: "-0",
			detail: diff === undefined ? "no diff" : "clean",
			color: Palette.idle,
			available: diff !== undefined,
		};
	}

	const summary = diff as NonNullable<typeof diff>;
	const files = `${summary.fileCount} file${summary.fileCount === 1 ? "" : "s"}`;
	const binary = summary.binaryFileCount === undefined ? "" : ` · ${summary.binaryFileCount} binary`;

	return {
		added: `+${summary.added}`,
		removed: `-${summary.removed}`,
		detail: `${files}${binary}`,
		color: summary.fileCount >= LARGE_CHANGE_FILES ? Palette.warn : Palette.accent,
		available: true,
	};
}
