/**
 * Action-layer regression tests.
 *
 * This layer had no coverage, and every settings-related defect the review found
 * lived here. The rule these tests encode: a settings change must survive the
 * *next* background repaint, not just the one repaint that follows it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The SDK is mocked so actions can be driven directly, with no host connection.
vi.mock("@elgato/streamdeck", () => {
	const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
	return {
		default: { logger },
		streamDeck: { logger },
		action: () => (target: unknown) => target,
		SingletonAction: class {},
	};
});

const { AgentStatusAction } = await import("@/actions/agent-status-action.js");
const { StopAction } = await import("@/actions/stop-action.js");
const { UsageAction } = await import("@/actions/usage-action.js");
const { GitAction } = await import("@/actions/git-action.js");
const { DashboardEncoderAction, cycleSegment, windowSelectionOf } =
	await import("@/actions/dashboard-encoder-action.js");
const { createFakeRuntime, usageSnapshot } = await import("../helpers/fake-runtime.js");
const { renderStopKey } = await import("@/presentation/renderers/key-renderer.js");

type Runtime = ReturnType<typeof createFakeRuntime>;

/** Stand-in for a Stream Deck key. */
class FakeKey {
	public images: string[] = [];
	public okCount = 0;
	public alertCount = 0;
	public readonly device = { id: "device-1" };
	public constructor(public readonly id = "key-1") {}
	public isKey(): boolean {
		return true;
	}
	public isDial(): boolean {
		return false;
	}
	public async setImage(image: string): Promise<void> {
		this.images.push(image);
	}
	public async showOk(): Promise<void> {
		this.okCount += 1;
	}
	public async showAlert(): Promise<void> {
		this.alertCount += 1;
	}
	public get lastImage(): string {
		return decodeURIComponent(this.images[this.images.length - 1] ?? "");
	}
}

/** Stand-in for a Stream Deck + dial and its 200x100 touch-strip region. */
class FakeDial {
	public feedback: Record<string, { value?: unknown }>[] = [];
	public layout: string | undefined;
	public settings: Record<string, unknown> = {};
	public readonly device = { id: "device-1" };
	public constructor(public readonly id = "dial-1") {}
	public isKey(): boolean {
		return false;
	}
	public isDial(): boolean {
		return true;
	}
	public async setFeedback(feedback: Record<string, { value?: unknown }>): Promise<void> {
		this.feedback.push(feedback);
	}
	public async setFeedbackLayout(layout: string): Promise<void> {
		this.layout = layout;
	}
	public async setSettings(settings: Record<string, unknown>): Promise<void> {
		this.settings = settings;
	}
	public get lastValue(): unknown {
		return this.feedback[this.feedback.length - 1]?.value?.value;
	}
	public get lastTitle(): unknown {
		return this.feedback[this.feedback.length - 1]?.title?.value;
	}
}

// The SDK builds a fresh payload object per event; these fakes do the same, which
// is what makes a captured-settings closure observable.
const appear = (action: unknown, settings: object, column?: number): never =>
	({
		action,
		payload: {
			settings: { ...settings },
			...(column === undefined ? {} : { coordinates: { column, row: 0 } }),
		},
	}) as never;

const rotate = (action: unknown, settings: object, ticks: number, column: number): never =>
	({
		action,
		payload: { settings: { ...settings }, ticks, coordinates: { column, row: 0 } },
	}) as never;

let fake: Runtime;

beforeEach(() => {
	fake = createFakeRuntime();
});

describe("settings changes survive later repaints", () => {
	it("UsageAction keeps a pinned window across a background usage push", async () => {
		const action = new UsageAction(fake.runtime);
		const key = new FakeKey();
		fake.provider.pushUsage();

		action.onWillAppear(appear(key, {}));
		expect(key.lastImage).toContain("96%");

		action.onDidReceiveSettings(appear(key, { windowMode: "pinned", windowId: "codex.primary" }));
		expect(key.lastImage).toContain("41%");

		// The regression: a later push must not revert to the willAppear settings.
		fake.provider.pushUsage();
		expect(key.lastImage).toContain("41%");
		expect(key.lastImage).not.toContain("96%");
	});

	it("UsageAction keeps a changed display mode across a repaint", async () => {
		const action = new UsageAction(fake.runtime);
		const key = new FakeKey();
		fake.provider.pushUsage();

		action.onWillAppear(appear(key, {}));
		action.onDidReceiveSettings(appear(key, { displayMode: "remaining" }));
		expect(key.lastImage).toContain("4%");

		fake.provider.pushUsage();
		expect(key.lastImage).toContain("4%");
	});

	it("AgentStatusAction keeps a fixed session across the one-second tick", async () => {
		const action = new AgentStatusAction(fake.runtime);
		const key = new FakeKey();
		fake.provider.pushUsage();
		fake.provider.pushSession({
			id: "thr_active",
			providerId: "codex",
			state: "working",
			updatedAt: new Date(),
		});
		fake.provider.pushSession({
			id: "thr_fixed",
			providerId: "codex",
			state: "idle",
			updatedAt: new Date(0),
		});

		action.onWillAppear(appear(key, {}));
		expect(key.lastImage).toContain("WORKING");

		action.onDidReceiveSettings(appear(key, { sessionMode: "fixed", sessionId: "thr_fixed" }));
		expect(key.lastImage).toContain("IDLE");

		// `tick` fires every second while a turn runs; it must not revert the key.
		fake.runtime.ui.invalidate("tick");
		expect(key.lastImage).toContain("IDLE");
		expect(key.lastImage).not.toContain("WORKING");
	});

	it("GitAction re-watches when the repository path changes", async () => {
		const paths: string[] = [];
		const local = createFakeRuntime({
			git: {
				isRepository: async () => true,
				getStatus: async (path) => {
					paths.push(path);
					const { gitStatus } = await import("../helpers/fake-runtime.js");
					return gitStatus({ repositoryPath: path, branch: path === "/one" ? "one" : "two" });
				},
			},
		});
		const action = new GitAction(local.runtime);
		const key = new FakeKey();

		action.onWillAppear(appear(key, { repositoryPath: "/one" }));
		await vi.waitFor(() => expect(key.lastImage).toContain("one"));

		action.onDidReceiveSettings(appear(key, { repositoryPath: "/two" }));
		await vi.waitFor(() => expect(key.lastImage).toContain("two"));

		expect(paths).toContain("/one");
		expect(paths).toContain("/two");
		await local.runtime.stop();
	});

	it("releases every subscription on willDisappear", async () => {
		const action = new UsageAction(fake.runtime);
		const key = new FakeKey();

		action.onWillAppear(appear(key, {}));
		const before = key.images.length;

		action.onWillDisappear(appear(key, {}));
		fake.provider.pushUsage();

		expect(key.images.length).toBe(before);
	});
});

describe("StopAction", () => {
	it("tracks whether anything can be interrupted", async () => {
		const action = new StopAction(fake.runtime);
		const key = new FakeKey();

		action.onWillAppear(appear(key, {}));
		expect(key.lastImage).toContain('opacity="0.35"');

		fake.provider.pushSession({ id: "thr_1", providerId: "codex", state: "working", updatedAt: new Date() });
		expect(key.lastImage).toBe(decodeURIComponent(renderStopKey(true)));
	});

	it("interrupts the active session on press", async () => {
		const action = new StopAction(fake.runtime);
		const key = new FakeKey();
		fake.provider.pushSession({ id: "thr_1", providerId: "codex", state: "working", updatedAt: new Date() });

		await action.onKeyDown(appear(key, {}));
		expect(fake.provider.interrupted).toEqual(["thr_1"]);
		expect(key.okCount).toBe(1);
	});

	it("alerts rather than throwing when nothing is running", async () => {
		const action = new StopAction(fake.runtime);
		const key = new FakeKey();

		await action.onKeyDown(appear(key, {}));
		expect(fake.provider.interrupted).toEqual([]);
		expect(key.alertCount).toBe(1);
	});
});

describe("dashboard encoder rotation", () => {
	it("pins the next usage window and shows it immediately", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		fake.provider.pushUsage();

		await action.onWillAppear(appear(dial, {}, 0));
		expect(dial.layout).toBe("layouts/segment.json");
		// Auto mode surfaces the most constrained window.
		expect(dial.lastValue).toBe("96%");

		await action.onDialRotate(rotate(dial, {}, 1, 0));

		expect(dial.settings).toMatchObject({ windowMode: "pinned", windowId: "codex.primary" });
		expect(dial.lastValue).toBe("41%");
	});

	it("steps through every window and back to auto", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		fake.provider.pushUsage();
		await action.onWillAppear(appear(dial, {}, 0));

		let settings: Record<string, unknown> = {};
		const seen: unknown[] = [];
		for (let i = 0; i < 3; i += 1) {
			await action.onDialRotate(rotate(dial, settings, 1, 0));
			settings = dial.settings;
			seen.push(settings.windowId ?? "auto");
		}
		// auto → primary → secondary → auto
		expect(seen).toEqual(["codex.primary", "codex.secondary", "auto"]);
	});

	it("rotates backwards", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		fake.provider.pushUsage();
		await action.onWillAppear(appear(dial, {}, 0));

		await action.onDialRotate(rotate(dial, {}, -1, 0));
		expect(dial.settings).toMatchObject({ windowId: "codex.secondary" });
	});

	it("changes the segment and redraws without waiting for didReceiveSettings", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		fake.provider.pushUsage();

		// Column 1 is AGENT; standalone mode honours the action's own preference.
		await action.onWillAppear(appear(dial, {}, 1));
		expect(dial.lastTitle).toBe("AGENT");

		await action.onDialRotate(rotate(dial, {}, 1, 1));

		expect(dial.settings.segment).toBe("git");
		// The plugin never receives its own setSettings back, so the redraw has to
		// happen here rather than on a didReceiveSettings that never arrives.
		expect(dial.lastTitle).toBe("GIT");
	});

	it("leaves settings alone when the provider reports no windows", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		fake.provider.pushUsage(usageSnapshot({ windows: [] }));
		await action.onWillAppear(appear(dial, {}, 0));

		await action.onDialRotate(rotate(dial, {}, 1, 0));
		expect(dial.settings).toEqual({});
	});

	it("resumes from auto when the pinned window has disappeared", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		fake.provider.pushUsage();
		await action.onWillAppear(appear(dial, {}, 0));

		await action.onDialRotate(rotate(dial, { windowMode: "pinned", windowId: "gone" }, 1, 0));
		expect(dial.settings).toMatchObject({ windowId: "codex.primary" });
	});

	it("publishes its window choice so background redraws keep it", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		fake.provider.pushUsage();
		await action.onWillAppear(appear(dial, {}, 0));
		await action.onDialRotate(rotate(dial, {}, 1, 0));

		expect(fake.contexts[fake.contexts.length - 1]?.windowSelection).toEqual({
			mode: "pinned",
			windowId: "codex.primary",
		});

		fake.provider.pushUsage();
		fake.runtime.refreshDashboard();
		expect(dial.lastValue).toBe("41%");
	});

	it("frees the column on willDisappear", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		await action.onWillAppear(appear(dial, {}, 0));
		expect(fake.runtime.dashboard.columnCount("device-1")).toBe(1);

		action.onWillDisappear(appear(dial, {}, 0));
		expect(fake.runtime.dashboard.columnCount("device-1")).toBe(0);
	});
});

describe("encoder helpers", () => {
	it("reads a pinned selection out of settings", () => {
		expect(windowSelectionOf({})).toEqual({ mode: "auto" });
		expect(windowSelectionOf({ windowMode: "pinned" })).toEqual({ mode: "auto" });
		expect(windowSelectionOf({ windowMode: "pinned", windowId: "a" })).toEqual({
			mode: "pinned",
			windowId: "a",
		});
	});

	it("cycles segment kinds in both directions", () => {
		expect(cycleSegment("usage", 1)).toBe("agent");
		expect(cycleSegment("usage", -1)).toBe("provider");
		expect(cycleSegment("provider", 1)).toBe("usage");
	});
});
