/**
 * Key image rendering.
 *
 * Keys are drawn as SVG data URIs: no image dependency, no binary assets to keep
 * in sync, and the text stays crisp at every key size. Design §3.5 governs the
 * content — a key shows a state, never a paragraph.
 */

import type { AgentStatusViewModel } from "../view-models/agent-status.js";
import type { GitViewModel } from "../view-models/git.js";
import type { UsageViewModel } from "../view-models/usage.js";
import { Palette } from "../view-models/colors.js";

const SIZE = 144;

export function svgToDataUri(svg: string): string {
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Truncates with an ellipsis so long labels cannot overflow a key. */
export function fit(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

interface KeyOptions {
	background?: string;
	dimmed?: boolean;
}

function frame(children: string, options: KeyOptions = {}): string {
	const opacity = options.dimmed === true ? 0.35 : 1;
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
		`<rect width="${SIZE}" height="${SIZE}" rx="18" fill="${options.background ?? Palette.background}"/>`,
		`<g opacity="${opacity}" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" text-anchor="middle">`,
		children,
		`</g></svg>`,
	].join("");
}

function text(
	value: string,
	y: number,
	size: number,
	color: string,
	weight: "400" | "600" | "700" = "600",
): string {
	return `<text x="${SIZE / 2}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeXml(value)}</text>`;
}

/** Design §12.1 — `CODEX / ● WORKING / 02:18`. */
export function renderAgentStatusKey(vm: AgentStatusViewModel): string {
	const parts = [
		text(fit(vm.providerLabel.toUpperCase(), 10), 34, 20, Palette.textMuted, "600"),
		`<circle cx="26" cy="70" r="9" fill="${vm.color}"/>`,
		text(fit(vm.stateLabel, 11), 78, 22, Palette.text, "700"),
	];
	if (vm.detail.length > 0) {
		parts.push(text(fit(vm.detail, 14), 112, 18, Palette.textMuted, "400"));
	}
	return svgToDataUri(frame(parts.join("")));
}

/** Design §12.2 — STOP renders dimmed when there is nothing to interrupt. */
export function renderStopKey(enabled: boolean): string {
	const color = enabled ? Palette.danger : Palette.offline;
	const body = [
		`<rect x="46" y="46" width="52" height="52" rx="8" fill="${color}"/>`,
		text("STOP", 128, 20, enabled ? Palette.text : Palette.textMuted, "700"),
	].join("");
	return svgToDataUri(frame(body, { dimmed: !enabled }));
}

/** Design §17 / §23.2 — provider, percentage and a clamped bar. */
export function renderUsageKey(vm: UsageViewModel): string {
	const barWidth = 104;
	const barX = (SIZE - barWidth) / 2;
	const filled = Math.round((barWidth * vm.barPercent) / 100);

	const parts = [
		text(fit(vm.providerLabel.toUpperCase(), 10), 32, 18, Palette.textMuted, "600"),
		text(vm.valueText, 78, 34, vm.available ? Palette.text : Palette.textMuted, "700"),
		`<rect x="${barX}" y="92" width="${barWidth}" height="10" rx="5" fill="${Palette.surface}"/>`,
	];
	if (filled > 0) {
		parts.push(`<rect x="${barX}" y="92" width="${filled}" height="10" rx="5" fill="${vm.color}"/>`);
	}
	const footer = vm.detail.length > 0 ? vm.detail : vm.windowLabel;
	if (footer.length > 0) {
		parts.push(text(fit(footer, 14), 126, 17, Palette.textMuted, "400"));
	}
	return svgToDataUri(frame(parts.join("")));
}

/** Design §16.1 — branch plus counts, nothing more. */
export function renderGitKey(vm: GitViewModel): string {
	const parts = [
		text("GIT", 30, 17, Palette.textMuted, "600"),
		text(fit(vm.branch, 12), 66, 21, vm.available ? Palette.text : Palette.textMuted, "700"),
	];
	if (vm.summary.length > 0) {
		parts.push(text(fit(vm.summary, 16), 96, 16, vm.color, "600"));
	}
	if (vm.detail.length > 0) {
		parts.push(text(fit(vm.detail, 14), 122, 16, Palette.textMuted, "400"));
	}
	return svgToDataUri(frame(parts.join("")));
}
