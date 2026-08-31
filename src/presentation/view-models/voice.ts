/**
 * Voice view model — design §13.4, §22.3.
 *
 * §22.3 asks for two things: that recording is unmistakable while it is
 * happening, and that its absence is equally checkable. The key therefore always
 * states one of the four words rather than only lighting up while live.
 */

import type { VoiceState } from "../../application/voice-service.js";
import { Palette } from "./colors.js";

export interface VoiceViewModel {
	label: string;
	detail: string;
	color: string;
	/** True while the microphone is open, which the renderer marks unmistakably. */
	live: boolean;
	available: boolean;
}

const LABELS: Readonly<Record<VoiceState, string>> = {
	idle: "MIC",
	listening: "LISTENING",
	transcribing: "…",
	unavailable: "MIC",
};

const COLORS: Readonly<Record<VoiceState, string>> = {
	idle: Palette.textMuted,
	listening: Palette.danger,
	transcribing: Palette.warn,
	unavailable: Palette.offline,
};

export function buildVoiceViewModel(input: {
	state: VoiceState;
	/** The preset the transcript will be sent through. */
	presetName?: string;
	errorLabel?: string;
}): VoiceViewModel {
	const state = input.state;
	const detail =
		state === "unavailable"
			? "not available"
			: state === "listening"
				? "release to send"
				: state === "transcribing"
					? "transcribing"
					: (input.errorLabel ?? input.presetName ?? "hold to talk");

	return {
		label: LABELS[state],
		detail,
		color: COLORS[state],
		live: state === "listening",
		available: state !== "unavailable",
	};
}
