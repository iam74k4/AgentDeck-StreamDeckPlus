/**
 * Renders documentation images from the real presentation layer.
 *
 * The point is that these pictures cannot drift: key faces come from
 * `key-renderer.ts`, touch-strip segments from `encoder-renderer.ts` drawn
 * through the same `layouts/segment.json` the device uses, and every state comes
 * from a real view model. Change a renderer and `npm run preview` shows it.
 */

import type { AgentSessionState } from "../domain/session.js";
import type { ProviderOverviewEntry } from "../application/usage-service.js";
import type { UsageSnapshot } from "../domain/usage.js";
import {
	escapeXml,
	renderAgentStatusKey,
	renderGitKey,
	renderStopKey,
	renderUsageKey,
} from "../presentation/renderers/key-renderer.js";
import {
	renderAgentSegment,
	renderGitSegment,
	renderOverviewSegment,
	renderUsageSegment,
	type SegmentFeedback,
} from "../presentation/renderers/encoder-renderer.js";
import { buildAgentStatusViewModel } from "../presentation/view-models/agent-status.js";
import { buildGitViewModel } from "../presentation/view-models/git.js";
import { buildOverviewViewModel } from "../presentation/view-models/overview.js";
import { buildUsageViewModel } from "../presentation/view-models/usage.js";
import { Palette } from "../presentation/view-models/colors.js";

// ------------------------------------------------------------------ the layout

/** The subset of `layouts/segment.json` the preview needs to draw a segment. */
export interface SegmentLayout {
	items: {
		key: string;
		type: string;
		rect: [number, number, number, number];
		color?: string;
		font?: { size?: number; weight?: number };
		bar_bg_c?: string;
		bar_fill_c?: string;
	}[];
}

const SEGMENT_WIDTH = 200;
const SEGMENT_HEIGHT = 100;

/** Draws one 200x100 encoder region exactly as the layout file defines it. */
function drawSegment(layout: SegmentLayout, feedback: SegmentFeedback): string {
	const parts = [`<rect width="${SEGMENT_WIDTH}" height="${SEGMENT_HEIGHT}" fill="${Palette.background}"/>`];

	for (const item of layout.items) {
		const value = feedback[item.key];
		if (value === undefined) {
			continue;
		}
		const [x, y, w, h] = item.rect;

		if (item.type === "bar") {
			const bar = value as { value: number; bar_fill_c?: string; opacity?: number };
			if (bar.opacity === 0) {
				continue;
			}
			const filled = Math.round((w * Math.min(100, Math.max(0, bar.value))) / 100);
			parts.push(
				`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${item.bar_bg_c ?? Palette.surface}"/>`,
			);
			if (filled > 0) {
				parts.push(
					`<rect x="${x}" y="${y}" width="${filled}" height="${h}" rx="${h / 2}" fill="${bar.bar_fill_c ?? item.bar_fill_c ?? Palette.ok}"/>`,
				);
			}
			continue;
		}

		const text = value as { value: string; color?: string };
		if (text.value === undefined || text.value.length === 0) {
			continue;
		}
		const size = item.font?.size ?? 13;
		const weight = item.font?.weight ?? 400;
		// The layout centres text in its rect; approximate the baseline the same way.
		const baseline = y + h / 2 + size * 0.35;
		parts.push(
			`<text x="${x + w / 2}" y="${baseline}" font-size="${size}" font-weight="${weight}" fill="${text.color ?? item.color ?? Palette.text}" text-anchor="middle" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif">${escapeXml(text.value)}</text>`,
		);
	}

	return parts.join("");
}

// ------------------------------------------------------------------- fixtures

const NOW = new Date(1_800_000_000_000);

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		providerId: "codex",
		status: "ready",
		fetchedAt: NOW,
		windows: [
			{ id: "codex.primary", label: "5h", usedPercent: 41, windowDurationMinutes: 300 },
			{ id: "codex.secondary", label: "7d", usedPercent: 12, windowDurationMinutes: 10_080 },
		],
		...overrides,
	};
}

function claudeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		providerId: "claude",
		status: "ready",
		fetchedAt: NOW,
		windows: [
			{ id: "claude.five_hour", label: "5h", usedPercent: 23.5, windowDurationMinutes: 300 },
			{ id: "claude.seven_day", label: "7d", usedPercent: 96, windowDurationMinutes: 10_080 },
		],
		...overrides,
	};
}

/** Design §18 — the two providers side by side, never summed. */
const OVERVIEW: ProviderOverviewEntry[] = [
	{
		providerId: "claude",
		displayName: "Claude",
		status: "ready",
		window: { id: "claude.seven_day", label: "7d", usedPercent: 96 },
	},
	{
		providerId: "codex",
		displayName: "Codex",
		status: "ready",
		window: { id: "codex.primary", label: "5h", usedPercent: 41 },
	},
];

function session(state: AgentSessionState, startedMsAgo?: number) {
	return {
		id: "thr_1",
		providerId: "codex",
		state,
		updatedAt: NOW,
		...(startedMsAgo === undefined ? {} : { startedAt: new Date(NOW.getTime() - startedMsAgo) }),
	};
}

const gitEntry = (overrides: Parameters<typeof buildGitViewModel>[0]) => buildGitViewModel(overrides);

function usageKey(options: Parameters<typeof buildUsageViewModel>[0]): string {
	return renderUsageKey(buildUsageViewModel({ now: NOW, ...options }));
}

function agentKey(options: Parameters<typeof buildAgentStatusViewModel>[0]): string {
	return renderAgentStatusKey(buildAgentStatusViewModel({ now: NOW, ...options }));
}

// -------------------------------------------------------------- svg utilities

/** Unwraps a key data URI back into inline SVG, scaled into place. */
function placeKey(dataUri: string, x: number, y: number, size: number): string {
	const svg = decodeURIComponent(dataUri.replace("data:image/svg+xml;charset=utf8,", ""));
	const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
	const scale = size / 144;
	return `<g transform="translate(${x},${y}) scale(${scale})">${inner}</g>`;
}

function label(text: string, x: number, y: number, size = 12, color: string = Palette.textMuted): string {
	return `<text x="${x}" y="${y}" font-size="${size}" font-weight="500" fill="${color}" text-anchor="middle" font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif">${escapeXml(text)}</text>`;
}

function document_(width: number, height: number, body: string): string {
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
		body,
		`</svg>`,
	].join("");
}

// ------------------------------------------------------------------ the sheets

const PAD = 32;
const CONTENT = 800;

/**
 * The device sheet: eight keys, the touch strip, and the four dials.
 *
 * All eight keys are the same four action types with different settings, and
 * every value is consistent with one Codex account at 41% of 5h and 96% of 7d.
 */
export function renderDeckPreview(layout: SegmentLayout): string {
	const keySize = 182;
	const keyGap = 24;
	const stripY = PAD + keySize * 2 + keyGap + 40;
	const dialY = stripY + SEGMENT_HEIGHT + 26;
	const height = dialY + 44 + PAD;
	const width = CONTENT + PAD * 2;

	const keys = [
		// Row 1 — the everyday four.
		agentKey({ providerLabel: "Codex", providerStatus: "ready", session: session("working", 138_000) }),
		renderStopKey(true),
		usageKey({
			providerLabel: "Codex",
			snapshot: snapshot(),
			selection: { mode: "pinned", windowId: "codex.primary" },
		}),
		renderGitKey(
			gitEntry({
				path: "/repo",
				fetchedAt: NOW,
				status: {
					repositoryPath: "/repo",
					branch: "main",
					detached: false,
					hasCommits: true,
					modified: 4,
					staged: 2,
					untracked: 1,
					conflicted: 0,
					ahead: 1,
					behind: 0,
				},
			}),
		),
		// Row 2 — the same actions, pointed at a second provider and other windows.
		agentKey({ providerLabel: "Codex", providerStatus: "ready", session: session("idle") }),
		// Keeps the reset-time detail row rendered end to end.
		usageKey({
			providerLabel: "Claude",
			snapshot: claudeSnapshot(),
			selection: { mode: "pinned", windowId: "claude.seven_day" },
			showResetAt: true,
		}),
		renderGitKey(
			gitEntry({
				path: "/docs",
				fetchedAt: NOW,
				status: {
					repositoryPath: "/docs",
					branch: "release/1.2",
					detached: false,
					hasCommits: true,
					modified: 0,
					staged: 0,
					untracked: 0,
					conflicted: 0,
					ahead: 0,
					behind: 2,
				},
			}),
		),
		// Keeps `remaining` mode rendered end to end; the preview is the only place
		// this view-model option is drawn.
		usageKey({
			providerLabel: "Claude",
			snapshot: claudeSnapshot(),
			selection: { mode: "pinned", windowId: "claude.five_hour" },
			displayMode: "remaining",
		}),
	];

	const segments = [
		renderUsageSegment(
			buildUsageViewModel({
				providerLabel: "Codex",
				snapshot: snapshot(),
				selection: { mode: "auto" },
				now: NOW,
			}),
		),
		renderAgentSegment(
			buildAgentStatusViewModel({
				providerLabel: "Codex",
				providerStatus: "ready",
				session: session("working", 138_000),
				now: NOW,
			}),
		),
		renderGitSegment(
			gitEntry({
				path: "/repo",
				fetchedAt: NOW,
				status: {
					repositoryPath: "/repo",
					branch: "main",
					detached: false,
					hasCommits: true,
					modified: 4,
					staged: 2,
					untracked: 1,
					conflicted: 0,
					ahead: 1,
					behind: 0,
				},
			}),
		),
		renderOverviewSegment(buildOverviewViewModel(OVERVIEW)),
	];

	const body = [
		`<rect width="${width}" height="${height}" rx="20" fill="#17191d"/>`,
		...keys.map((key, index) => {
			const column = index % 4;
			const row = Math.floor(index / 4);
			const x = PAD + column * (keySize + keyGap) + (CONTENT - (keySize * 4 + keyGap * 3)) / 2;
			return placeKey(key, x, PAD + row * (keySize + keyGap), keySize);
		}),
		`<g transform="translate(${PAD},${stripY})">`,
		`<rect x="-4" y="-4" width="${CONTENT + 8}" height="${SEGMENT_HEIGHT + 8}" rx="10" fill="#0b0c0e"/>`,
		...segments.map(
			(segment, index) =>
				`<g transform="translate(${index * SEGMENT_WIDTH},0)">${drawSegment(layout, segment)}</g>`,
		),
		`</g>`,
		// The four dials, drawn where they sit under the strip.
		...[0, 1, 2, 3].map((index) => {
			const cx = PAD + index * SEGMENT_WIDTH + SEGMENT_WIDTH / 2;
			return [
				`<circle cx="${cx}" cy="${dialY + 16}" r="16" fill="#25282e" stroke="#3a3e46" stroke-width="2"/>`,
				`<circle cx="${cx}" cy="${dialY + 16}" r="4" fill="#3a3e46"/>`,
				label("ROTATE · PRESS", cx, dialY + 44, 9, "#4a4d52"),
			].join("");
		}),
	].join("");

	return document_(width, height, body);
}

/** The state sheet: one key face per state the deck can show. */
export function renderStatePreview(): string {
	const cells: { key: string; caption: string; note: string }[] = [
		{
			key: agentKey({ providerLabel: "Codex", providerStatus: "ready", session: session("idle") }),
			caption: "IDLE",
			note: "connected, nothing running",
		},
		{
			key: agentKey({
				providerLabel: "Codex",
				providerStatus: "ready",
				session: session("working", 138_000),
			}),
			caption: "WORKING",
			note: "turn in flight, elapsed",
		},
		{
			key: agentKey({
				providerLabel: "Codex",
				providerStatus: "ready",
				session: session("waiting-approval"),
			}),
			caption: "APPROVAL",
			note: "agent is waiting on you",
		},
		{
			key: agentKey({ providerLabel: "Codex", providerStatus: "ready", session: session("completed") }),
			caption: "DONE",
			note: "turn finished",
		},
		{
			key: agentKey({ providerLabel: "Codex", providerStatus: "ready", session: session("error") }),
			caption: "ERROR",
			note: "the turn failed",
		},
		{
			key: agentKey({ providerLabel: "Codex", providerStatus: "ready", session: session("disconnected") }),
			caption: "OFFLINE",
			note: "app-server went away",
		},
		{
			key: agentKey({ providerLabel: "Codex", providerStatus: "cli-not-found" }),
			caption: "CLI?",
			note: "codex not on PATH",
		},
		{
			key: agentKey({ providerLabel: "Codex", providerStatus: "login-required" }),
			caption: "LOGIN",
			note: "account not signed in",
		},
		{
			key: agentKey({
				providerLabel: "Claude",
				providerStatus: "login-required",
				errorCode: "NOT_CONFIGURED",
			}),
			caption: "SETUP",
			note: "Claude bridge not configured",
		},
		{
			key: usageKey({
				providerLabel: "Codex",
				snapshot: snapshot({ status: "stale" }),
				selection: { mode: "pinned", windowId: "codex.primary" },
			}),
			caption: "STALE",
			note: "last good reading kept",
		},
		{
			key: usageKey({
				providerLabel: "Codex",
				snapshot: snapshot({
					status: "rate-limited",
					windows: [{ id: "codex.primary", label: "5h", usedPercent: 100 }],
				}),
				selection: { mode: "auto" },
			}),
			caption: "LIMIT",
			note: "quota reached",
		},
		{
			key: renderGitKey(gitEntry({ path: "/tmp", fetchedAt: NOW, errorCode: "GIT_NOT_REPOSITORY" })),
			caption: "NO GIT",
			note: "path is not a repository",
		},
	];

	const columns = 4;
	const cell = CONTENT / columns;
	const keySize = 116;
	const rowHeight = keySize + 54;
	const width = CONTENT + PAD * 2;
	const height = PAD * 2 + rowHeight * Math.ceil(cells.length / columns);

	const body = [
		`<rect width="${width}" height="${height}" rx="20" fill="#17191d"/>`,
		...cells.flatMap((entry, index) => {
			const x = PAD + (index % columns) * cell;
			const y = PAD + Math.floor(index / columns) * rowHeight;
			const centre = x + cell / 2;
			return [
				placeKey(entry.key, centre - keySize / 2, y, keySize),
				label(entry.caption, centre, y + keySize + 20, 13, Palette.text),
				label(entry.note, centre, y + keySize + 36, 10.5, Palette.textMuted),
			];
		}),
	].join("");

	return document_(width, height, body);
}
