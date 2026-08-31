/**
 * Spike B — key/segment rendering and the four-encoder coordinator.
 */
import { describe, expect, it, vi } from "vitest";
import {
	DASHBOARD_COLUMNS,
	ENCODER_COLUMN_COUNT,
	isColumn,
	PlusDashboardCoordinator,
	renderSegment,
	type DashboardData,
	type EncoderContext,
} from "@/presentation/plus-dashboard-coordinator.js";
import {
	escapeXml,
	estimateWidth,
	fit,
	renderAgentStatusKey,
	renderApprovalKey,
	renderPromptKey,
	renderStopKey,
	renderVoiceKey,
	wrapLabel,
	renderUsageKey,
} from "@/presentation/renderers/key-renderer.js";
import { buildAgentStatusViewModel, formatElapsed } from "@/presentation/view-models/agent-status.js";
import { buildUsageViewModel, formatResetIn } from "@/presentation/view-models/usage.js";
import type { ApprovalRequest } from "@/domain/approval.js";
import { buildApproveKeyViewModel, buildDenyKeyViewModel } from "@/presentation/view-models/approval.js";
import { buildDiffViewModel } from "@/presentation/view-models/diff.js";
import { buildSessionViewModel } from "@/presentation/view-models/session.js";
import { buildGitViewModel } from "@/presentation/view-models/git.js";
import { buildModelViewModel } from "@/presentation/view-models/model.js";
import { buildPromptViewModel } from "@/presentation/view-models/prompt.js";
import { buildVoiceViewModel } from "@/presentation/view-models/voice.js";
import { DEFAULT_PROMPT_PRESETS, type PromptPreset } from "@/domain/prompt.js";
import { buildOverviewViewModel } from "@/presentation/view-models/overview.js";
import { buildProjectViewModel } from "@/presentation/view-models/project.js";
import { buildProviderViewModel } from "@/presentation/view-models/provider.js";
import { usageColor, Palette } from "@/presentation/view-models/colors.js";
import type { UsageSnapshot } from "@/domain/usage.js";

const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
	providerId: "codex",
	status: "ready",
	fetchedAt: new Date(0),
	windows: [
		{ id: "default.primary", label: "5h", usedPercent: 41 },
		{ id: "default.secondary", label: "7d", usedPercent: 96 },
	],
	...overrides,
});

describe("usage view model (design §7.5, §17.3)", () => {
	it("shows the most constrained window in auto mode", () => {
		const vm = buildUsageViewModel({
			providerLabel: "Codex",
			snapshot: snapshot(),
			selection: { mode: "auto" },
		});
		expect(vm.valueText).toBe("96%");
		expect(vm.windowLabel).toBe("7d");
		expect(vm.color).toBe(Palette.danger);
	});

	it("shows `--` for a pinned window that no longer exists", () => {
		const vm = buildUsageViewModel({
			providerLabel: "Codex",
			snapshot: snapshot(),
			selection: { mode: "pinned", windowId: "gone" },
		});
		expect(vm.valueText).toBe("--");
		expect(vm.available).toBe(false);
	});

	it("can display remaining instead of used", () => {
		const vm = buildUsageViewModel({
			providerLabel: "Codex",
			snapshot: snapshot(),
			selection: { mode: "pinned", windowId: "default.primary" },
			displayMode: "remaining",
		});
		expect(vm.valueText).toBe("59%");
		// The bar always tracks usage, regardless of the readout.
		expect(vm.barPercent).toBe(41);
	});

	it("marks a stale snapshot rather than hiding it", () => {
		const vm = buildUsageViewModel({
			providerLabel: "Codex",
			snapshot: snapshot({ status: "stale" }),
			selection: { mode: "auto" },
		});
		expect(vm.detail).toContain("STALE");
		expect(vm.available).toBe(true);
	});

	it("renders a short badge for an unusable provider", () => {
		const vm = buildUsageViewModel({
			providerLabel: "Codex",
			snapshot: snapshot({
				status: "cli-not-found",
				windows: [],
				error: { code: "CLI_NOT_FOUND", message: "not found" },
			}),
			selection: { mode: "auto" },
		});
		expect(vm.valueText).toBe("CLI?");
	});

	it("formats reset countdowns compactly", () => {
		const now = new Date(0);
		expect(formatResetIn(new Date(30 * 60_000), now)).toBe("resets 30m");
		expect(formatResetIn(new Date(3 * 3_600_000), now)).toBe("resets 3h");
		expect(formatResetIn(new Date(5 * 86_400_000), now)).toBe("resets 5d");
		expect(formatResetIn(new Date(-1), now)).toBe("resets now");
	});

	it("colours by threshold", () => {
		expect(usageColor(10)).toBe(Palette.ok);
		expect(usageColor(80)).toBe(Palette.warn);
		expect(usageColor(95)).toBe(Palette.danger);
		expect(usageColor(80, 90, 99)).toBe(Palette.ok);
	});
});

describe("agent status view model (design §12.1)", () => {
	it("shows elapsed time while a turn runs", () => {
		const vm = buildAgentStatusViewModel({
			providerLabel: "Codex",
			providerStatus: "ready",
			session: {
				id: "thr_1",
				providerId: "codex",
				state: "working",
				startedAt: new Date(0),
				updatedAt: new Date(0),
			},
			now: new Date(138_000),
		});
		expect(vm.stateLabel).toBe("WORKING");
		expect(vm.detail).toBe("02:18");
		expect(vm.interruptible).toBe(true);
	});

	it("lets an unusable provider outrank a stale session", () => {
		const vm = buildAgentStatusViewModel({
			providerLabel: "Codex",
			providerStatus: "cli-not-found",
			session: { id: "thr_1", providerId: "codex", state: "working", updatedAt: new Date(0) },
		});
		expect(vm.stateLabel).toBe("CLI?");
		expect(vm.interruptible).toBe(false);
	});

	it("reports when there is no session at all", () => {
		expect(buildAgentStatusViewModel({ providerLabel: "Codex", providerStatus: "ready" }).stateLabel).toBe(
			"NO SESSION",
		);
	});

	it("formats long turns in hours", () => {
		expect(formatElapsed(new Date(0), new Date(3_900_000))).toBe("1h05");
	});
});

describe("key rendering", () => {
	it("produces an SVG data URI", () => {
		const image = renderUsageKey(
			buildUsageViewModel({ providerLabel: "Codex", snapshot: snapshot(), selection: { mode: "auto" } }),
		);
		expect(image.startsWith("data:image/svg+xml;charset=utf8,")).toBe(true);
		expect(decodeURIComponent(image)).toContain("96%");
	});

	it("dims the stop key when nothing can be interrupted", () => {
		expect(decodeURIComponent(renderStopKey(false))).toContain('opacity="0.35"');
		expect(decodeURIComponent(renderStopKey(true))).toContain('opacity="1"');
	});

	it("escapes text so a branch name cannot break the SVG", () => {
		expect(escapeXml("a<b>&\"'")).toBe("a&lt;b&gt;&amp;&quot;&apos;");
		const image = decodeURIComponent(
			renderAgentStatusKey({
				providerLabel: "<x>",
				stateLabel: "IDLE",
				detail: "",
				color: "#fff",
				plan: "",
				interruptible: false,
			}),
		);
		expect(image).toContain("&lt;X&gt;");
	});

	it("keeps the status dot clear of the state label at every length", () => {
		// A fixed dot position collided with anything longer than about six
		// characters, which covered most of the state vocabulary.
		for (const stateLabel of ["IDLE", "WORKING", "APPROVAL", "NO SESSION", "OFFLINE"]) {
			const svg = decodeURIComponent(
				renderAgentStatusKey({
					providerLabel: "Codex",
					stateLabel,
					detail: "",
					color: "#2fbf71",
					plan: "",
					interruptible: false,
				}),
			);

			const dot = /<circle cx="([\d.]+)" cy="[\d.]+" r="([\d.]+)"/.exec(svg);
			const text = /<text x="([\d.]+)" y="79" font-size="([\d.]+)"/.exec(svg);
			expect(dot, stateLabel).not.toBeNull();
			expect(text, stateLabel).not.toBeNull();

			const dotRight = Number(dot?.[1]) + Number(dot?.[2]);
			const textLeft = Number(text?.[1]);
			expect(textLeft, `${stateLabel} overlaps the dot`).toBeGreaterThan(dotRight);

			// The whole unit stays inside the 144px key.
			const size = Number(text?.[2]);
			const textRight = textLeft + stateLabel.length * size * 0.66;
			expect(textRight, `${stateLabel} overflows the key`).toBeLessThanOrEqual(144);
			expect(Number(dot?.[1]) - Number(dot?.[2]), `${stateLabel} starts off-key`).toBeGreaterThanOrEqual(0);
		}
	});

	it("truncates rather than overflowing a key", () => {
		expect(fit("short", 10)).toBe("short");
		expect(fit("a-very-long-branch-name", 10)).toBe("a-very-lo…");
	});
});

describe("four-encoder coordination (design §6.2, instructions §8.3)", () => {
	const data: DashboardData = {
		usage: buildUsageViewModel({ providerLabel: "Codex", snapshot: snapshot(), selection: { mode: "auto" } }),
		agent: buildAgentStatusViewModel({ providerLabel: "Codex", providerStatus: "ready" }),
		git: buildGitViewModel(undefined),
		diff: buildDiffViewModel(undefined),
		session: buildSessionViewModel({ total: 0 }),
		model: buildModelViewModel({
			providerId: "codex",
			supported: true,
			models: [{ id: "gpt-5.1-codex", label: "GPT-5.1 Codex" }],
			choices: [{ modelId: "gpt-5.1-codex" }],
			highlighted: { modelId: "gpt-5.1-codex" },
			applied: { modelId: "gpt-5.1-codex" },
			loading: false,
			error: undefined,
		}),
		prompt: buildPromptViewModel({ preset: DEFAULT_PROMPT_PRESETS[0] as PromptPreset }),
		voice: buildVoiceViewModel({ state: "idle" }),
		overview: buildOverviewViewModel([]),
		project: buildProjectViewModel({ total: 0 }),
		provider: buildProviderViewModel({ label: "Codex", status: "ready" }),
	};

	const context = (id: string, preferred?: EncoderContext["preferredSegment"]): EncoderContext => ({
		id,
		...(preferred === undefined ? {} : { preferredSegment: preferred }),
		setFeedback: vi.fn(),
	});

	it("switches to dashboard mode only once all four columns are claimed", () => {
		const coordinator = new PlusDashboardCoordinator();
		for (let column = 0; column < ENCODER_COLUMN_COUNT; column += 1) {
			expect(coordinator.mode("dev-1")).toBe("standalone");
			coordinator.register("dev-1", column as 0 | 1 | 2 | 3, context(`a${column}`));
		}
		expect(coordinator.mode("dev-1")).toBe("dashboard");
		expect(coordinator.segmentFor("dev-1", 2)).toBe(DASHBOARD_COLUMNS[2]);
	});

	it("honours the action's own segment while standalone", () => {
		const coordinator = new PlusDashboardCoordinator();
		coordinator.register("dev-1", 0, context("a0", "git"));
		expect(coordinator.mode("dev-1")).toBe("standalone");
		expect(coordinator.segmentFor("dev-1", 0)).toBe("git");
	});

	it("falls back to the column default when standalone with no preference", () => {
		const coordinator = new PlusDashboardCoordinator();
		coordinator.register("dev-1", 1, context("a1"));
		expect(coordinator.segmentFor("dev-1", 1)).toBe("agent");
	});

	it("releases a column on willDisappear and drops the device when empty", () => {
		const coordinator = new PlusDashboardCoordinator();
		coordinator.register("dev-1", 0, context("a0"));
		coordinator.register("dev-1", 1, context("a1"));
		coordinator.unregister("dev-1", "a0");
		expect(coordinator.columnCount("dev-1")).toBe(1);
		coordinator.unregister("dev-1", "a1");
		expect(coordinator.deviceIds).toEqual([]);
	});

	it("keeps devices independent", () => {
		const coordinator = new PlusDashboardCoordinator();
		for (let column = 0; column < ENCODER_COLUMN_COUNT; column += 1) {
			coordinator.register("dev-1", column as 0 | 1 | 2 | 3, context(`a${column}`));
		}
		coordinator.register("dev-2", 0, context("b0", "usage"));
		expect(coordinator.mode("dev-1")).toBe("dashboard");
		expect(coordinator.mode("dev-2")).toBe("standalone");
	});

	it("pushes feedback to every registered encoder on update", () => {
		const coordinator = new PlusDashboardCoordinator();
		const first = context("a0");
		const second = context("a1");
		coordinator.register("dev-1", 0, first);
		coordinator.register("dev-1", 1, second);

		coordinator.update(data);

		expect(first.setFeedback).toHaveBeenCalledWith(
			expect.objectContaining({ title: { value: "CODEX", color: Palette.textMuted } }),
		);
		expect(second.setFeedback).toHaveBeenCalledWith(
			expect.objectContaining({ title: { value: "AGENT", color: Palette.textMuted } }),
		);
	});

	it("renders a newly registered encoder immediately from the last data", () => {
		const coordinator = new PlusDashboardCoordinator();
		coordinator.update(data);
		const late = context("late");
		coordinator.register("dev-1", 2, late);
		expect(late.setFeedback).toHaveBeenCalled();
	});

	it("keeps drawing the other segments when one setFeedback throws", () => {
		const errors: unknown[] = [];
		const coordinator = new PlusDashboardCoordinator({ onError: (error) => errors.push(error) });
		const broken: EncoderContext = {
			id: "broken",
			setFeedback: () => {
				throw new Error("device gone");
			},
		};
		const healthy = context("healthy");
		coordinator.register("dev-1", 0, broken);
		coordinator.register("dev-1", 1, healthy);

		coordinator.update(data);
		expect(errors).toHaveLength(1);
		expect(healthy.setFeedback).toHaveBeenCalled();
	});

	it("reports occupancy so callers can idle when no encoder is placed", () => {
		const changes: boolean[] = [];
		const coordinator = new PlusDashboardCoordinator({ onOccupancyChange: (o) => changes.push(o) });
		expect(coordinator.occupied).toBe(false);

		coordinator.register("dev-1", 0, context("a0"));
		coordinator.register("dev-1", 1, context("a1"));
		// Only the 0↔1 transitions are reported, not every registration.
		expect(changes).toEqual([true]);

		coordinator.unregister("dev-1", "a0");
		expect(changes).toEqual([true]);

		coordinator.unregister("dev-1", "a1");
		expect(changes).toEqual([true, false]);
		expect(coordinator.occupied).toBe(false);
	});

	it("validates encoder columns", () => {
		expect(isColumn(0)).toBe(true);
		expect(isColumn(3)).toBe(true);
		expect(isColumn(4)).toBe(false);
		expect(isColumn(-1)).toBe(false);
	});

	it("hides the segment bar when there is no usage value to show", () => {
		const feedback = renderSegment("usage", {
			...data,
			usage: buildUsageViewModel({
				providerLabel: "Codex",
				snapshot: snapshot({ status: "loading", windows: [] }),
				selection: { mode: "auto" },
			}),
		});
		expect(feedback.bar.opacity).toBe(0);
	});
});

describe("approval key rendering (design §12.4, §22.2)", () => {
	const decode = (image: string): string =>
		decodeURIComponent(image.replace("data:image/svg+xml;charset=utf8,", ""));

	const request = (risk: "low" | "high"): ApprovalRequest => ({
		id: "req_1",
		sessionId: "thr_1",
		type: "command",
		title: risk === "high" ? "rm -rf build" : "npm run build",
		summary: "",
		risk,
	});

	it("labels a low-risk request APPROVE and a high-risk one HOLD", () => {
		expect(decode(renderApprovalKey(buildApproveKeyViewModel({ request: request("low") })))).toContain(
			"APPROVE",
		);
		expect(decode(renderApprovalKey(buildApproveKeyViewModel({ request: request("high") })))).toContain(
			"HOLD",
		);
	});

	it("keeps the plate label inside its plate", () => {
		// The regression: at a fixed 24px, "APPROVE" overflowed the filled plate and
		// — being drawn in the background colour — rendered as "PPROV".
		const svg = decode(renderApprovalKey(buildApproveKeyViewModel({ request: request("low") })));
		const plateWidth = Number(/<rect x="[\d.]+" y="34" width="([\d.]+)"/.exec(svg)?.[1]);
		const fontSize = Number(/font-size="([\d.]+)" font-weight="700"/.exec(svg)?.[1]);

		expect(plateWidth).toBeGreaterThan(0);
		expect(estimateWidth("APPROVE", fontSize)).toBeLessThanOrEqual(plateWidth);
	});

	it("fills the hold ring in proportion to the hold", () => {
		const none = decode(renderApprovalKey(buildApproveKeyViewModel({ request: request("high") })));
		const half = decode(
			renderApprovalKey(buildApproveKeyViewModel({ request: request("high"), holdProgress: 0.5 })),
		);
		// No arc at all until the key is actually being held.
		expect(none).not.toContain("stroke-dashoffset");
		expect(half).toContain("stroke-dashoffset");
	});

	it("dims and says so when there is nothing waiting", () => {
		const svg = decode(renderApprovalKey(buildApproveKeyViewModel({})));
		expect(svg).toContain("nothing waiting");
		expect(svg).toContain('opacity="0.35"');
	});

	it("never draws a hold ring on Deny", () => {
		const svg = decode(renderApprovalKey(buildDenyKeyViewModel({ request: request("high") })));
		expect(svg).toContain("DENY");
		expect(svg).not.toContain("stroke-dasharray");
	});
});

describe("prompt and voice key rendering (design §13.4, §14)", () => {
	const decode = (image: string): string =>
		decodeURIComponent(image.replace("data:image/svg+xml;charset=utf8,", ""));

	const widest = (svg: string): number => {
		// Every label's estimated width, so none of them can exceed the key.
		const matches = [...svg.matchAll(/font-size="([\d.]+)"[^>]*>([^<]*)</g)];
		return Math.max(...matches.map(([, size, value]) => estimateWidth(value ?? "", Number(size))));
	};

	it("keeps a two-word preset name on the key instead of truncating it", () => {
		const svg = decode(
			renderPromptKey(
				buildPromptViewModel({
					preset: {
						id: "debug-screen",
						name: "Debug Screen",
						template: "",
						inputSource: "screenshot",
						target: "active-session",
					},
				}),
			),
		);
		// Both words survive, on their own lines.
		expect(svg).toContain(">Debug<");
		expect(svg).toContain(">Screen<");
		expect(svg).not.toContain("…");
		expect(widest(svg)).toBeLessThanOrEqual(144);
	});

	it("shrinks a single long word rather than letting it run off the key", () => {
		const svg = decode(
			renderPromptKey(
				buildPromptViewModel({
					preset: {
						id: "x",
						name: "Internationalisation",
						template: "",
						inputSource: "none",
						target: "clipboard",
					},
				}),
			),
		);
		expect(widest(svg)).toBeLessThanOrEqual(144);
	});

	it("keeps a long detail line inside the key too", () => {
		const svg = decode(
			renderPromptKey({
				name: "Custom",
				detail: "selection → new session",
				position: "7/10",
				color: "#3d8bfd",
				available: true,
			}),
		);
		expect(widest(svg)).toBeLessThanOrEqual(144);
	});

	it("wraps only when it has to", () => {
		expect(wrapLabel("Review", 128, 26)).toEqual(["Review"]);
		expect(wrapLabel("Debug Screen", 128, 26)).toEqual(["Debug", "Screen"]);
		// A single word cannot be split, so it stays whole and is shrunk instead.
		expect(wrapLabel("Internationalisation", 128, 26)).toEqual(["Internationalisation"]);
	});

	it("draws a live microphone as filled and an idle one as an outline (design §22.3)", () => {
		const live = decode(renderVoiceKey(buildVoiceViewModel({ state: "listening" })));
		const idle = decode(renderVoiceKey(buildVoiceViewModel({ state: "idle" })));

		expect(live).toContain("LISTENING");
		expect(live).toContain('fill="#e5484d"');
		expect(idle).toContain("MIC");
		expect(idle).toContain('fill="none"');
	});

	it("dims the microphone when voice input is unavailable", () => {
		const svg = decode(renderVoiceKey(buildVoiceViewModel({ state: "unavailable" })));
		expect(svg).toContain("not available");
		expect(svg).toContain('opacity="0.35"');
	});
});
