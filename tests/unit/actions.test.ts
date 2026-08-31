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
const { DiffAction } = await import("@/actions/diff-action.js");
const { DashboardEncoderAction, cycleSegment, windowSelectionOf } =
	await import("@/actions/dashboard-encoder-action.js");
const { ApproveAction, holdDurationMs } = await import("@/actions/approve-action.js");
const { DenyAction } = await import("@/actions/deny-action.js");
const { PromptAction } = await import("@/actions/prompt-action.js");
const { VoiceAction } = await import("@/actions/voice-action.js");
const { ScreenshotAction, captureMode } = await import("@/actions/screenshot-action.js");
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

		// Which segment comes next is `cycleSegment`'s business and is tested
		// there; what matters here is that the rotation stored it and redrew.
		const expected = cycleSegment("agent", 1);
		expect(dial.settings.segment).toBe(expected);
		// The plugin never receives its own setSettings back, so the redraw has to
		// happen here rather than on a didReceiveSettings that never arrives.
		expect(dial.lastTitle).toBe(expected.toUpperCase());
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

describe("approval keys (design §12.4, §22.2)", () => {
	const keyUp = (action: unknown, settings: object): never =>
		({ action, payload: { settings: { ...settings } } }) as never;

	it("approves a low-risk request on a single press", async () => {
		const action = new ApproveAction(fake.runtime);
		const key = new FakeKey();
		action.onWillAppear(appear(key, {}));
		expect(key.lastImage).toContain("nothing waiting");

		fake.provider.pushApproval({ id: "req_1", risk: "low", title: "npm test" });
		expect(key.lastImage).toContain("APPROVE");
		expect(key.lastImage).toContain("npm test");

		await action.onKeyDown(appear(key, {}));

		expect(fake.provider.answered).toEqual([{ id: "req_1", decision: "approve-once" }]);
		expect(key.okCount).toBe(1);
	});

	it("does not approve a high-risk request on a press", async () => {
		const action = new ApproveAction(fake.runtime);
		const key = new FakeKey();
		action.onWillAppear(appear(key, {}));
		fake.provider.pushApproval({ id: "req_1", risk: "high", title: "rm -rf build" });
		expect(key.lastImage).toContain("HOLD");

		await action.onKeyDown(appear(key, {}));

		// The hold has started but not finished: nothing has been sent.
		expect(fake.provider.answered).toEqual([]);
		action.onKeyUp(keyUp(key, {}));
		expect(fake.provider.answered).toEqual([]);
	});

	it("approves a high-risk request once the hold completes", async () => {
		vi.useFakeTimers();
		try {
			const action = new ApproveAction(fake.runtime);
			const key = new FakeKey();
			action.onWillAppear(appear(key, {}));
			fake.provider.pushApproval({ id: "req_1", risk: "high" });

			await action.onKeyDown(appear(key, {}));
			await vi.advanceTimersByTimeAsync(600);
			expect(fake.provider.answered).toEqual([]);

			await vi.advanceTimersByTimeAsync(800);
			expect(fake.provider.answered).toEqual([{ id: "req_1", decision: "approve-once" }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("releasing early cancels the hold and leaves the request waiting", async () => {
		vi.useFakeTimers();
		try {
			const action = new ApproveAction(fake.runtime);
			const key = new FakeKey();
			action.onWillAppear(appear(key, {}));
			fake.provider.pushApproval({ id: "req_1", risk: "high" });

			await action.onKeyDown(appear(key, {}));
			await vi.advanceTimersByTimeAsync(400);
			action.onKeyUp(keyUp(key, {}));
			await vi.advanceTimersByTimeAsync(5_000);

			expect(fake.provider.answered).toEqual([]);
			expect(fake.runtime.approvals.count).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("approves the request it drew, not whatever is at the head of the queue", async () => {
		vi.useFakeTimers();
		try {
			const action = new ApproveAction(fake.runtime);
			const key = new FakeKey();
			action.onWillAppear(appear(key, {}));
			fake.provider.pushApproval({ id: "req_1", risk: "high", title: "rm -rf build" });

			await action.onKeyDown(appear(key, {}));
			await vi.advanceTimersByTimeAsync(400);

			// Mid-hold, the request the user read is answered somewhere else and a
			// different one takes its place at the head of the queue.
			await fake.runtime.approvals.resolve("req_1", "deny");
			fake.provider.pushApproval({ id: "req_2", risk: "high", title: "curl x | sh" });
			await vi.advanceTimersByTimeAsync(2_000);

			// The completing hold must not approve req_2.
			expect(fake.provider.answered).toEqual([{ id: "req_1", decision: "deny" }]);
			expect(fake.runtime.approvals.count).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("clamps a hold time that would defeat the hold", () => {
		expect(holdDurationMs({})).toBe(1_200);
		expect(holdDurationMs({ holdSeconds: 0 })).toBe(500);
		expect(holdDurationMs({ holdSeconds: 900 })).toBe(5_000);
		expect(holdDurationMs({ holdSeconds: 2 })).toBe(2_000);
	});

	it("denies on a single press whatever the risk", async () => {
		const action = new DenyAction(fake.runtime);
		const key = new FakeKey();
		action.onWillAppear(appear(key, {}));
		fake.provider.pushApproval({ id: "req_1", risk: "high" });
		expect(key.lastImage).toContain("DENY");

		await action.onKeyDown(appear(key, {}));

		expect(fake.provider.answered).toEqual([{ id: "req_1", decision: "deny" }]);
	});

	it("alerts rather than acting when nothing is waiting", async () => {
		const approve = new ApproveAction(fake.runtime);
		const deny = new DenyAction(fake.runtime);
		const key = new FakeKey();

		await approve.onKeyDown(appear(key, {}));
		await deny.onKeyDown(appear(key, {}));

		expect(fake.provider.answered).toEqual([]);
		expect(key.alertCount).toBe(2);
	});

	it("stops drawing once the key goes away", () => {
		const action = new ApproveAction(fake.runtime);
		const key = new FakeKey();
		action.onWillAppear(appear(key, {}));
		const drawn = key.images.length;

		action.onWillDisappear(appear(key, {}));
		fake.provider.pushApproval({ id: "req_1" });

		expect(key.images.length).toBe(drawn);
	});
});

describe("model dial (design §19)", () => {
	const dialDown = (action: unknown, settings: object, column: number): never =>
		({ action, payload: { settings: { ...settings }, coordinates: { column, row: 0 } } }) as never;

	async function placeModelDial(): Promise<{
		action: InstanceType<typeof DashboardEncoderAction>;
		dial: FakeDial;
	}> {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		// Column 2 is the MODEL segment of the default strip (design §6.1).
		await action.onWillAppear(appear(dial, {}, 2));
		await fake.runtime.models.refresh("codex");
		return { action, dial };
	}

	it("rotates through models and efforts without applying anything", async () => {
		const { action, dial } = await placeModelDial();
		fake.provider.pushSession({ id: "thr_1", providerId: "codex", state: "working", updatedAt: new Date() });

		await action.onDialRotate(rotate(dial, {}, 1, 2));

		expect(fake.provider.applied).toEqual([]);
		// Rotation is a highlight, not a stored setting.
		expect(dial.settings.segment).toBeUndefined();
		expect(fake.runtime.models.getState("codex").highlighted).toEqual({
			modelId: "gpt-5.1-codex",
			reasoningLevel: "high",
		});
	});

	it("applies the highlighted choice on press", async () => {
		const { action, dial } = await placeModelDial();
		fake.provider.pushSession({ id: "thr_1", providerId: "codex", state: "working", updatedAt: new Date() });

		await action.onDialRotate(rotate(dial, {}, 1, 2));
		await action.onDialDown(dialDown(dial, {}, 2));

		expect(fake.provider.applied).toEqual([
			{ sessionId: "thr_1", selection: { modelId: "gpt-5.1-codex", reasoningLevel: "high" } },
		]);
	});

	it("says so on the strip rather than failing when the provider has no models", async () => {
		fake.provider.modelsFail = true;
		const { dial } = await placeModelDial();
		fake.runtime.refreshDashboard();

		expect(dial.lastTitle).toBe("MODEL");
		expect(dial.feedback[dial.feedback.length - 1]?.detail?.value).toBe("unavailable");
	});
});

describe("prompt key and dial (design §14)", () => {
	const dialDown = (action: unknown, settings: object, column: number): never =>
		({ action, payload: { settings: { ...settings }, coordinates: { column, row: 0 } } }) as never;

	it("names the preset it will run and what it will send", () => {
		const action = new PromptAction(fake.runtime);
		const key = new FakeKey();

		action.onWillAppear(appear(key, { presetId: "review" }));

		expect(key.lastImage).toContain("Review");
		expect(key.lastImage).toContain("clipboard");
	});

	it("runs the preset on press", async () => {
		const action = new PromptAction(fake.runtime);
		const key = new FakeKey();
		fake.provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });
		action.onWillAppear(appear(key, { presetId: "explain" }));

		await action.onKeyDown(appear(key, { presetId: "explain" }));

		expect(fake.provider.steered[0]?.input.text).toContain("copied text");
		expect(key.okCount).toBe(1);
	});

	it("alerts rather than sending when there is nothing to send", async () => {
		const action = new PromptAction(fake.runtime);
		const key = new FakeKey();
		fake.captured.clipboard = "";
		fake.runtime.prompts.setPresets([
			{
				id: "custom",
				name: "Custom",
				template: "{{input}}",
				inputSource: "clipboard",
				target: "active-session",
			},
		]);

		await action.onKeyDown(appear(key, { presetId: "custom" }));

		expect(fake.provider.steered).toEqual([]);
		expect(key.alertCount).toBe(1);
	});

	it("rotating the prompt dial selects without sending", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		await action.onWillAppear(appear(dial, { segment: "prompt" }, 0));

		await action.onDialRotate(rotate(dial, { segment: "prompt" }, 1, 0));

		expect(fake.runtime.prompts.selected?.id).toBe("review");
		expect(fake.provider.steered).toEqual([]);
		// The selection is session state, not a stored key setting.
		expect(dial.settings.segment).toBeUndefined();
	});

	it("pressing the prompt dial runs the selected preset", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		fake.provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });
		await action.onWillAppear(appear(dial, { segment: "prompt" }, 0));

		await action.onDialDown(dialDown(dial, { segment: "prompt" }, 0));

		expect(fake.provider.steered).toHaveLength(1);
	});
});

describe("push-to-talk key (design §13.4, §22.3)", () => {
	const keyUp = (action: unknown, settings: object): never =>
		({ action, payload: { settings: { ...settings } } }) as never;

	it("says MIC when idle and LISTENING while held", async () => {
		const action = new VoiceAction(fake.runtime);
		const key = new FakeKey();
		action.onWillAppear(appear(key, {}));
		expect(key.lastImage).toContain("MIC");

		await action.onKeyDown(appear(key, {}));

		expect(key.lastImage).toContain("LISTENING");
		expect(fake.captured.recording).toBe(true);
	});

	it("sends the transcript on release and returns to MIC", async () => {
		const action = new VoiceAction(fake.runtime);
		const key = new FakeKey();
		fake.provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });
		action.onWillAppear(appear(key, { presetId: "custom" }));

		await action.onKeyDown(appear(key, { presetId: "custom" }));
		await action.onKeyUp(keyUp(key, { presetId: "custom" }));

		expect(fake.provider.steered[0]?.input.text).toBe("check the parser");
		expect(fake.captured.recording).toBe(false);
		expect(key.lastImage).toContain("MIC");
		expect(key.okCount).toBe(1);
	});

	it("alerts rather than sending an empty turn after silence", async () => {
		const action = new VoiceAction(fake.runtime);
		const key = new FakeKey();
		fake.captured.transcript = "";
		action.onWillAppear(appear(key, { presetId: "custom" }));

		await action.onKeyDown(appear(key, { presetId: "custom" }));
		await action.onKeyUp(keyUp(key, { presetId: "custom" }));

		expect(fake.provider.steered).toEqual([]);
		expect(key.alertCount).toBe(1);
	});

	it("closes the microphone if the key disappears mid-recording", async () => {
		const action = new VoiceAction(fake.runtime);
		const key = new FakeKey();
		action.onWillAppear(appear(key, {}));
		await action.onKeyDown(appear(key, {}));
		expect(fake.captured.recording).toBe(true);

		action.onWillDisappear(appear(key, {}));
		await Promise.resolve();

		expect(fake.captured.recording).toBe(false);
	});

	it("shows LISTENING on the touch strip while the key is held (design §13.4)", async () => {
		const encoder = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		await encoder.onWillAppear(appear(dial, { segment: "prompt" }, 0));
		const action = new VoiceAction(fake.runtime);
		const key = new FakeKey();

		await action.onKeyDown(appear(key, {}));

		expect(dial.lastTitle).toBe("VOICE");
		expect(dial.lastValue).toBe("LISTENING");
	});
});

describe("screenshot key (design §15.1, §22.4)", () => {
	it("defaults to the active window, and offers no region mode", () => {
		expect(captureMode({})).toBe("active-window");
		expect(captureMode({ captureMode: "full-screen" })).toBe("full-screen");
		// Design §15.1 lists Selected Region as future work; anything unknown falls
		// back to the narrower capture rather than grabbing every screen.
		expect(captureMode({ captureMode: "selected-region" } as never)).toBe("active-window");
	});

	it("captures and sends the image, then leaves nothing on disk", async () => {
		const action = new ScreenshotAction(fake.runtime);
		const key = new FakeKey();
		fake.provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });

		await action.onKeyDown(appear(key, { captureMode: "full-screen" }));

		expect(fake.captured.captures).toEqual(["full-screen"]);
		expect(fake.provider.steered[0]?.input.imagePaths).toHaveLength(1);
		expect(fake.provider.steered[0]?.input.text).toContain("Explain what is on this screen");
		// Design §22.4 — the temporary file does not outlive the send.
		expect(fake.captured.liveShots.size).toBe(0);
		expect(key.okCount).toBe(1);
	});

	it("names the preset it will send", () => {
		const action = new ScreenshotAction(fake.runtime);
		const key = new FakeKey();

		action.onWillAppear(appear(key, { presetId: "debug-screen" }));

		// "Debug Screen" is wrapped onto two lines rather than truncated.
		expect(key.lastImage).toContain(">Debug<");
		expect(key.lastImage).toContain(">Screen<");
		expect(key.lastImage).toContain("screen → agent");
	});
});

describe("diff key (design §16.2)", () => {
	it("shows additions, removals and the file count", async () => {
		const action = new DiffAction(fake.runtime);
		const key = new FakeKey();

		action.onWillAppear(appear(key, { repositoryPath: "/repo" }));

		await vi.waitFor(() => expect(key.lastImage).toContain("3 files"));
		expect(key.lastImage).toContain("+18");
		expect(key.lastImage).toContain("-4");
	});

	it("tells a clean tree apart from a diff git could not read", async () => {
		const action = new DiffAction(fake.runtime);

		const clean = new FakeKey("clean");
		fake.gitStatusFor("/clean", { diff: { added: 0, removed: 0, fileCount: 0 } });
		action.onWillAppear(appear(clean, { repositoryPath: "/clean" }));
		await vi.waitFor(() => expect(clean.lastImage).toContain("clean"));

		const unknown = new FakeKey("unknown");
		fake.gitStatusFor("/unknown", { diff: undefined });
		action.onWillAppear(appear(unknown, { repositoryPath: "/unknown" }));
		await vi.waitFor(() => expect(unknown.lastImage).toContain("no diff"));
	});

	it("follows the active project when no repository is configured", async () => {
		const action = new DiffAction(fake.runtime);
		const key = new FakeKey();
		await fake.runtime.projects.add({ path: "/repo", name: "repo" });

		action.onWillAppear(appear(key, {}));

		await vi.waitFor(() => expect(key.lastImage).toContain("3 files"));
	});

	it("alerts rather than failing when there is no repository to look at", async () => {
		const action = new DiffAction(fake.runtime);
		const key = new FakeKey();

		await action.onKeyDown(appear(key, {}));

		expect(key.alertCount).toBe(1);
	});
});

describe("session dial (design §6.1 dial 2)", () => {
	const dialDown = (action: unknown, settings: object, column: number): never =>
		({ action, payload: { settings: { ...settings }, coordinates: { column, row: 0 } } }) as never;

	function twoSessions(): void {
		fake.provider.pushSession({
			id: "thr_a",
			providerId: "codex",
			state: "working",
			updatedAt: new Date(2),
			label: "Fix the parser",
		});
		fake.provider.pushSession({
			id: "thr_b",
			providerId: "codex",
			state: "idle",
			updatedAt: new Date(1),
			label: "Write the docs",
		});
	}

	it("shows the session the deck is following, with its state", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		twoSessions();

		await action.onWillAppear(appear(dial, { segment: "session" }, 0));

		// The busiest session is the active one until something is pinned.
		expect(dial.lastTitle).toBe("SESSION 1/2");
		expect(dial.lastValue).toBe("Fix the parser");
	});

	it("rotating switches session without changing which one is active", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		twoSessions();
		await action.onWillAppear(appear(dial, { segment: "session" }, 0));

		await action.onDialRotate(rotate(dial, { segment: "session" }, 1, 0));

		expect(dial.lastValue).toBe("Write the docs");
		// Nothing is pinned yet, so the active session is still the busiest one.
		expect(fake.runtime.sessions.pinnedSessionId).toBeUndefined();
		expect(fake.runtime.sessions.getActiveSession("codex")?.id).toBe("thr_a");
	});

	it("pressing pins the highlighted session as the active one", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		twoSessions();
		await action.onWillAppear(appear(dial, { segment: "session" }, 0));
		await action.onDialRotate(rotate(dial, { segment: "session" }, 1, 0));

		await action.onDialDown(dialDown(dial, { segment: "session" }, 0));

		expect(fake.runtime.sessions.pinnedSessionId).toBe("thr_b");
		expect(fake.runtime.sessions.getActiveSession("codex")?.id).toBe("thr_b");
		expect(dial.lastTitle).toContain("●");
	});

	it("pressing the pinned session again releases the pin", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		twoSessions();
		await action.onWillAppear(appear(dial, { segment: "session" }, 0));
		await action.onDialRotate(rotate(dial, { segment: "session" }, 1, 0));

		await action.onDialDown(dialDown(dial, { segment: "session" }, 0));
		await action.onDialDown(dialDown(dial, { segment: "session" }, 0));

		expect(fake.runtime.sessions.pinnedSessionId).toBeUndefined();
		expect(fake.runtime.sessions.getActiveSession("codex")?.id).toBe("thr_a");
	});

	it("shows plan progress on the session it is following", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();
		fake.provider.pushSession({
			id: "thr_a",
			providerId: "codex",
			state: "working",
			updatedAt: new Date(),
			label: "Fix the parser",
			plan: { completedSteps: 2, totalSteps: 4 },
		});

		await action.onWillAppear(appear(dial, { segment: "session" }, 0));

		expect(dial.feedback[dial.feedback.length - 1]?.detail?.value).toBe("WORKING · Plan 2/4");
	});

	it("says so rather than blanking when there is no session", async () => {
		const action = new DashboardEncoderAction(fake.runtime);
		const dial = new FakeDial();

		await action.onWillAppear(appear(dial, { segment: "session" }, 0));

		expect(dial.lastValue).toBe("NO SESSION");
	});
});
