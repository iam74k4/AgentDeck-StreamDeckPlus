/**
 * Project view model — design §6.1, §7.1.
 */

import type { Project } from "../../domain/project.js";
import { Palette } from "./colors.js";

export interface ProjectViewModel {
	name: string;
	detail: string;
	color: string;
	available: boolean;
}

export function buildProjectViewModel(input: {
	active?: Project;
	total: number;
	/** Branch and dirty count for the active project, when known. */
	gitSummary?: string;
}): ProjectViewModel {
	if (input.active === undefined) {
		return {
			name: input.total === 0 ? "NO PROJECT" : "--",
			detail: input.total === 0 ? "add one" : "",
			color: Palette.offline,
			available: false,
		};
	}

	const position = input.total > 1 ? `${input.total} projects` : "";
	return {
		name: input.active.name,
		detail: input.gitSummary ?? position,
		color: Palette.accent,
		available: true,
	};
}
