/**
 * Touch-strip segment rendering — design §6.2, instructions §8.2.
 *
 * Each encoder owns a 200x100 region rendered through the custom
 * `layouts/segment.json` layout. Segments show state, never prose.
 *
 * The returned object is intentionally a plain structure so it can be asserted in
 * unit tests; it is structurally compatible with the SDK's `FeedbackPayload`.
 */

import type { AgentStatusViewModel } from "../view-models/agent-status.js";
import type { DiffViewModel } from "../view-models/diff.js";
import type { GitViewModel } from "../view-models/git.js";
import type { ModelViewModel } from "../view-models/model.js";
import type { OverviewViewModel } from "../view-models/overview.js";
import type { ProjectViewModel } from "../view-models/project.js";
import type { PromptViewModel } from "../view-models/prompt.js";
import type { VoiceViewModel } from "../view-models/voice.js";
import type { ProviderViewModel } from "../view-models/provider.js";
import type { SessionViewModel } from "../view-models/session.js";
import type { UsageViewModel } from "../view-models/usage.js";
import { Palette } from "../view-models/colors.js";
import { fit } from "./key-renderer.js";

export const SEGMENT_LAYOUT_ID = "layouts/segment.json";

export interface SegmentText {
	value: string;
	color?: string;
}

export interface SegmentBar {
	value: number;
	bar_fill_c?: string;
	/** The SDK models opacity as a fixed step scale; the bar is only shown or hidden. */
	opacity?: 0 | 1;
}

/**
 * The index signature keeps this assignable to the SDK's `FeedbackPayload`
 * without a cast at the call site.
 */
export type SegmentFeedback = {
	title: SegmentText;
	value: SegmentText;
	detail: SegmentText;
	bar: SegmentBar;
} & Record<string, SegmentText | SegmentBar>;

function segment(
	title: string,
	value: string,
	detail: string,
	color: string,
	barPercent = 0,
	showBar = false,
): SegmentFeedback {
	return {
		title: { value: title, color: Palette.textMuted },
		value: { value: value, color: Palette.text },
		detail: { value: detail, color: Palette.textMuted },
		bar: { value: Math.round(barPercent), bar_fill_c: color, opacity: showBar ? 1 : 0 },
	};
}

export function renderUsageSegment(vm: UsageViewModel): SegmentFeedback {
	// The window label always stays on screen; STALE/LIMIT/reset text appends to it,
	// so a warning can never hide which window the percentage belongs to.
	const detail = [vm.windowLabel, vm.detail].filter((part) => part.length > 0).join(" · ");
	return segment(
		fit(vm.providerLabel.toUpperCase(), 14),
		vm.valueText,
		fit(detail, 20),
		vm.color,
		vm.barPercent,
		vm.available,
	);
}

export function renderAgentSegment(vm: AgentStatusViewModel): SegmentFeedback {
	// Design §6.1 puts `Plan 2/4` on the strip's detail row; §12.1 puts the
	// elapsed time there. With both, both fit.
	const detail = [vm.detail, vm.plan].filter((part) => part.length > 0).join(" · ");
	const feedback = segment("AGENT", fit(vm.stateLabel, 12), fit(detail, 20), vm.color);
	feedback.value.color = vm.color;
	return feedback;
}

export function renderGitSegment(vm: GitViewModel): SegmentFeedback {
	const detail = [vm.summary, vm.detail].filter((part) => part.length > 0).join("  ");
	return segment("GIT", fit(vm.branch, 14), fit(detail, 24), vm.color);
}

export function renderProviderSegment(vm: ProviderViewModel): SegmentFeedback {
	const feedback = segment(
		fit(vm.label.toUpperCase(), 14),
		fit(vm.statusLabel, 12),
		fit(vm.detail, 20),
		vm.color,
	);
	feedback.value.color = vm.color;
	return feedback;
}

/** Design §18 — the constrained provider leads, the rest follow. */
export function renderOverviewSegment(vm: OverviewViewModel): SegmentFeedback {
	return segment(
		fit(vm.headline, 16),
		vm.valueText,
		fit(vm.detail, 26),
		vm.color,
		vm.barPercent,
		vm.available,
	);
}

/** Design §6.1 — the active project and how many there are to switch between. */
/** Design §6.1 — the MODEL column of the default touch strip. */
export function renderModelSegment(vm: ModelViewModel): SegmentFeedback {
	return segment("MODEL", fit(vm.title, 14), fit(vm.detail, 20), vm.color);
}

/**
 * Design §6.1 dial 2 — rotate switches session, press makes it the active one.
 *
 * A pin marker rather than a colour change: the colour already carries the
 * session's state, and pinned is a different question from busy.
 */
export function renderSessionSegment(vm: SessionViewModel): SegmentFeedback {
	const title = [vm.pinned ? "SESSION ●" : "SESSION", vm.position]
		.filter((part) => part.length > 0)
		.join(" ");
	return segment(title, fit(vm.name, 14), fit(vm.detail, 22), vm.color);
}

/** Design §16.2 — the size of the change, not the change. */
export function renderDiffSegment(vm: DiffViewModel): SegmentFeedback {
	const value = vm.removed.length > 0 ? `${vm.added} ${vm.removed}` : vm.added;
	return segment("DIFF", fit(value, 14), fit(vm.detail, 22), vm.color);
}

/**
 * Design §6.1 dial 3 — rotate selects a preset, press runs it.
 *
 * While the microphone is open this segment shows LISTENING instead: design
 * §13.4 puts that on the touch strip, and the prompt segment is where the
 * transcript is about to go.
 */
export function renderPromptSegment(vm: PromptViewModel, voice?: VoiceViewModel): SegmentFeedback {
	if (voice?.live === true) {
		return segment("VOICE", voice.label, fit(voice.detail, 22), voice.color);
	}
	const title = vm.position.length > 0 ? `PROMPT ${vm.position}` : "PROMPT";
	return segment(title, fit(vm.name, 14), fit(vm.detail, 22), vm.color);
}

export function renderProjectSegment(vm: ProjectViewModel): SegmentFeedback {
	const feedback = segment("PROJECT", fit(vm.name, 14), fit(vm.detail, 24), vm.color);
	feedback.value.color = vm.available ? Palette.text : Palette.textMuted;
	return feedback;
}
