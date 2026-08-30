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
	fit,
	renderAgentStatusKey,
	renderStopKey,
	renderUsageKey,
} from "@/presentation/renderers/key-renderer.js";
import { buildAgentStatusViewModel, formatElapsed } from "@/presentation/view-models/agent-status.js";
import { buildUsageViewModel, formatResetIn } from "@/presentation/view-models/usage.js";
import { buildGitViewModel } from "@/presentation/view-models/git.js";
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
				interruptible: false,
			}),
		);
		expect(image).toContain("&lt;X&gt;");
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
