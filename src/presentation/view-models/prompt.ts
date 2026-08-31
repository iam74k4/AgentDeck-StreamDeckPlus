/**
 * Prompt preset view model — design §14.
 *
 * The dial shows which preset is selected and where its input comes from, so a
 * press is never a guess about what is about to be sent.
 */

import type { PromptPreset } from "../../domain/prompt.js";
import { Palette } from "./colors.js";

export interface PromptViewModel {
	name: string;
	/** `clipboard → agent`. Kept short enough for a 200px segment. */
	detail: string;
	/** `2/10` while there is more than one preset to rotate through, else empty. */
	position: string;
	color: string;
	available: boolean;
}

const SOURCE_LABELS: Readonly<Record<PromptPreset["inputSource"], string>> = {
	none: "no input",
	clipboard: "clipboard",
	selection: "selection",
	screenshot: "screen",
};

const TARGET_LABELS: Readonly<Record<PromptPreset["target"], string>> = {
	"active-session": "→ agent",
	"new-session": "→ new session",
	clipboard: "→ clipboard",
};

export function buildPromptViewModel(input: {
	preset?: PromptPreset;
	/** Position in the list, shown when there is more than one to rotate through. */
	index?: number;
	total?: number;
}): PromptViewModel {
	const preset = input.preset;
	if (preset === undefined) {
		return { name: "PROMPT", detail: "none set", position: "", color: Palette.offline, available: false };
	}
	// The position rides in the segment's title rather than the detail line: at
	// 200px the two together push "clipboard → agent" off the end.
	const position =
		input.total !== undefined && input.total > 1 && input.index !== undefined
			? `${input.index + 1}/${input.total}`
			: "";
	return {
		name: preset.name,
		detail: `${SOURCE_LABELS[preset.inputSource]} ${TARGET_LABELS[preset.target]}`,
		position,
		color: Palette.accent,
		available: true,
	};
}
