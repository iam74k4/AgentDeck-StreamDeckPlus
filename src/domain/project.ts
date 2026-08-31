/**
 * Project domain model — design §7.1.
 *
 * A Project binds a local directory to an AI working context. It is intentionally
 * separate from AgentSession and from ProviderId (design §3.4).
 */

import type { ProviderId } from "./usage.js";

export interface ProjectCommands {
	start?: string;
	build?: string;
	test?: string;
}

export interface Project {
	id: string;
	name: string;
	path: string;

	preferredProviderId?: ProviderId;
	preferredModelId?: string;

	commands?: ProjectCommands;
}

export type ProjectValidationCode = "ok" | "empty-path" | "not-absolute" | "not-found" | "not-a-directory";

export interface ProjectValidation {
	code: ProjectValidationCode;
	valid: boolean;
	message?: string;
}

/**
 * Shape-level validation of a project path. Filesystem existence is checked by the
 * adapter layer, which passes its result in as {@link stat}.
 */
export function validateProjectPath(
	rawPath: string,
	stat?: { exists: boolean; isDirectory: boolean },
): ProjectValidation {
	const path = rawPath.trim();
	if (path.length === 0) {
		return { code: "empty-path", valid: false, message: "Project path is empty." };
	}
	if (!isAbsolutePath(path)) {
		return {
			code: "not-absolute",
			valid: false,
			message: "Project path must start with a drive letter, a UNC share, or /.",
		};
	}
	if (stat !== undefined) {
		if (!stat.exists) {
			return { code: "not-found", valid: false, message: "Project path does not exist." };
		}
		if (!stat.isDirectory) {
			return { code: "not-a-directory", valid: false, message: "Project path is not a directory." };
		}
	}
	return { code: "ok", valid: true };
}

/**
 * Absolute-path test that is stable across the host OS, so the same rule can be
 * unit-tested on Linux CI while the MVP target is Windows (design §27).
 *
 * A drive-relative path such as `\\src\\game` is deliberately rejected even though
 * Windows calls it absolute: it resolves against whichever drive happens to be
 * current, which is not something a persisted project setting should depend on.
 */
function isAbsolutePath(path: string): boolean {
	return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}

/** Derives a display name from a path when the user did not supply one. */
export function deriveProjectName(path: string): string {
	const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
	return segments[segments.length - 1] ?? path;
}
