/**
 * Model / reasoning selector view model — design §19.
 *
 *   Rotate → Model / Effort
 *   Press  → Apply
 *
 * The highlighted choice and the applied one are shown as different things on
 * purpose: a dial that has been rotated but not pressed has changed nothing yet,
 * and the segment has to say so.
 */

import { isSameSelection, type ModelSelection } from "../../domain/model.js";
import type { ModelState } from "../../application/model-service.js";
import { Palette } from "./colors.js";

export interface ModelViewModel {
	/** The model being pointed at. */
	title: string;
	/** Reasoning effort, or a hint when there is nothing to show. */
	detail: string;
	color: string;
	available: boolean;
	/** True while the highlight differs from what the session is running. */
	dirty: boolean;
}

function labelFor(state: ModelState, selection: ModelSelection): string {
	const model = state.models.find((candidate) => candidate.id === selection.modelId);
	return model?.label ?? selection.modelId;
}

export function buildModelViewModel(state: ModelState): ModelViewModel {
	if (!state.supported) {
		return {
			title: "MODEL",
			detail: "not supported",
			color: Palette.offline,
			available: false,
			dirty: false,
		};
	}
	if (state.error !== undefined) {
		return { title: "MODEL", detail: "unavailable", color: Palette.danger, available: false, dirty: false };
	}
	if (state.loading && state.choices.length === 0) {
		return { title: "MODEL", detail: "loading…", color: Palette.idle, available: false, dirty: false };
	}

	const selection = state.highlighted;
	if (selection === undefined) {
		return { title: "MODEL", detail: "rotate to load", color: Palette.idle, available: false, dirty: false };
	}

	const dirty = !isSameSelection(selection, state.applied);
	return {
		title: labelFor(state, selection),
		// A dirty choice reads as an instruction, because pressing is what applies it.
		detail: dirty
			? `${selection.reasoningLevel ?? "default"} · press`
			: (selection.reasoningLevel ?? "default"),
		color: dirty ? Palette.accent : Palette.ok,
		available: true,
		dirty,
	};
}
