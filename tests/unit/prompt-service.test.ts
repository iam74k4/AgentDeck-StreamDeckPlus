/**
 * Prompt presets, their input sources and their targets — design §14, §15, §22.4.
 *
 * Two properties matter beyond "it sends the right text": capture is only ever
 * triggered by a caller, and a screenshot's temporary file does not outlive the
 * send (§22.4).
 */

import { describe, expect, it, vi } from "vitest";
import { PromptService } from "@/application/prompt-service.js";
import { ProviderRegistry } from "@/application/provider-registry.js";
import { SessionService } from "@/application/session-service.js";
import type { Clipboard } from "@/adapters/desktop/clipboard.js";
import type { ScreenshotCapture } from "@/adapters/desktop/screenshot.js";
import { clampInput, renderPrompt, type PromptPreset } from "@/domain/prompt.js";
import { ControllableProvider } from "../helpers/fake-runtime.js";

function preset(overrides: Partial<PromptPreset> = {}): PromptPreset {
	return {
		id: "explain",
		name: "Explain",
		template: "Explain this:\n\n{{input}}",
		inputSource: "clipboard",
		target: "active-session",
		...overrides,
	};
}

function setup(options: { presets?: PromptPreset[] } = {}) {
	const registry = new ProviderRegistry();
	const provider = new ControllableProvider();
	registry.register(provider);
	const sessions = new SessionService(registry);

	const live = new Set<string>();
	const captures: string[] = [];
	const written: string[] = [];
	const clipboard: Clipboard = {
		read: async () => "const x = 1;",
		readSelection: async () => "selected code",
	};
	const screenshot: ScreenshotCapture = {
		capture: async (mode) => {
			captures.push(mode);
			const path = "/tmp/shot.png";
			live.add(path);
			return { path, dispose: async () => void live.delete(path) };
		},
	};

	const prompts = new PromptService(sessions, {
		clipboard,
		screenshot,
		writeClipboard: async (text) => void written.push(text),
	});
	prompts.setPresets(options.presets ?? [preset()]);
	return { prompts, provider, sessions, live, captures, written };
}

describe("renderPrompt", () => {
	it("substitutes the placeholder", () => {
		expect(renderPrompt("Explain:\n\n{{input}}", "x = 1")).toBe("Explain:\n\nx = 1");
	});

	it("appends the input when the template forgot the placeholder", () => {
		// A user-edited preset must not silently drop what they copied.
		expect(renderPrompt("Explain this", "x = 1")).toBe("Explain this\n\nx = 1");
	});

	it("leaves a template with no input alone", () => {
		expect(renderPrompt("Summarise the diff", undefined)).toBe("Summarise the diff");
	});
});

describe("clampInput", () => {
	it("passes ordinary input through untouched", () => {
		expect(clampInput("short")).toBe("short");
	});

	it("caps something enormous and says that it did", () => {
		const clamped = clampInput("x".repeat(50), 10);
		expect(clamped.startsWith("x".repeat(10))).toBe(true);
		expect(clamped).toContain("truncated by AgentDeck");
	});
});

describe("PromptService", () => {
	it("fills the template from the clipboard and sends it to the active session", async () => {
		const { prompts, provider } = setup();
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });

		await prompts.run("explain", { providerId: "codex" });

		expect(provider.steered).toEqual([
			{ sessionId: "thr_1", input: { text: "Explain this:\n\nconst x = 1;" } },
		]);
	});

	it("uses the selection when the preset asks for one", async () => {
		const { prompts, provider } = setup({ presets: [preset({ inputSource: "selection" })] });
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });

		await prompts.run("explain", { providerId: "codex" });

		expect(provider.steered[0]?.input.text).toContain("selected code");
	});

	it("prefers text the caller supplies over the preset's input source", async () => {
		// This is what dictation does: the spoken words are the input, so reading
		// the clipboard on top of them would send something never said.
		const { prompts, provider } = setup();
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });

		await prompts.run("explain", { providerId: "codex", text: "check the parser" });

		expect(provider.steered[0]?.input.text).toBe("Explain this:\n\ncheck the parser");
	});

	it("copies to the clipboard when that is the target, without touching an agent", async () => {
		const { prompts, provider, written } = setup({ presets: [preset({ target: "clipboard" })] });

		const result = await prompts.run("explain", { providerId: "codex" });

		expect(written).toEqual(["Explain this:\n\nconst x = 1;"]);
		expect(provider.steered).toEqual([]);
		expect(result.session).toBeUndefined();
	});

	it("opens a session when the preset targets a new one", async () => {
		const { prompts, provider } = setup({ presets: [preset({ target: "new-session" })] });

		await prompts.run("explain", { providerId: "codex", cwd: "C:/work/Game" });

		expect(provider.startedSessions).toEqual([{ cwd: "C:/work/Game" }]);
		expect(provider.steered[0]?.sessionId).toBe("thr_new");
	});

	it("attaches a screenshot and deletes it afterwards", async () => {
		const { prompts, provider, live, captures } = setup({
			presets: [preset({ inputSource: "screenshot", template: "What is wrong here?" })],
		});
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });

		await prompts.run("explain", { providerId: "codex" });

		expect(captures).toEqual(["active-window"]);
		expect(provider.steered[0]?.input.imagePaths).toEqual(["/tmp/shot.png"]);
		// Design §22.4 — nothing left on disk.
		expect(live.size).toBe(0);
	});

	it("deletes the screenshot even when the send fails", async () => {
		const { prompts, provider, live } = setup({
			presets: [preset({ inputSource: "screenshot", template: "What is wrong here?" })],
		});
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });
		provider.steerFails = true;

		await expect(prompts.run("explain", { providerId: "codex" })).rejects.toThrow();

		expect(live.size).toBe(0);
	});

	it("refuses to send an empty prompt", async () => {
		const registry = new ProviderRegistry();
		const provider = new ControllableProvider();
		registry.register(provider);
		const prompts = new PromptService(new SessionService(registry), {
			clipboard: { read: async () => "", readSelection: async () => "" },
		});
		prompts.setPresets([preset({ template: "{{input}}" })]);

		await expect(prompts.run("explain", { providerId: "codex" })).rejects.toMatchObject({
			code: "NOT_CONFIGURED",
		});
		expect(provider.steered).toEqual([]);
	});

	it("says so rather than failing obscurely when the clipboard is unavailable", async () => {
		const registry = new ProviderRegistry();
		registry.register(new ControllableProvider());
		const prompts = new PromptService(new SessionService(registry));
		prompts.setPresets([preset()]);

		await expect(prompts.run("explain", { providerId: "codex" })).rejects.toMatchObject({
			code: "NOT_CONFIGURED",
		});
	});

	it("rotates through presets and wraps", () => {
		const { prompts } = setup({ presets: [preset(), preset({ id: "review", name: "Review" })] });

		expect(prompts.selected?.id).toBe("explain");
		prompts.rotate(1);
		expect(prompts.selected?.id).toBe("review");
		prompts.rotate(1);
		expect(prompts.selected?.id).toBe("explain");
		prompts.rotate(-1);
		expect(prompts.selected?.id).toBe("review");
	});

	it("falls back to the defaults rather than leaving the dial empty", () => {
		const { prompts } = setup();
		prompts.setPresets([]);
		expect(prompts.list().length).toBeGreaterThan(0);

		prompts.setPresets([{ nonsense: true }, preset()]);
		expect(prompts.list().map((entry) => entry.id)).toEqual(["explain"]);
	});

	it("does not repaint when the presets are set to what they already are", () => {
		// `applyGlobalSettings` runs on every global settings write, including a
		// project being added, so this is called far more often than it changes.
		const { prompts } = setup({ presets: [preset()] });
		const listener = vi.fn();
		prompts.subscribe(listener);

		prompts.setPresets([preset()]);

		expect(listener).not.toHaveBeenCalled();
	});

	it("notifies subscribers when the selection changes", () => {
		const { prompts } = setup({ presets: [preset(), preset({ id: "review" })] });
		const listener = vi.fn();
		prompts.subscribe(listener);

		prompts.rotate(1);

		expect(listener).toHaveBeenCalledTimes(1);
	});
});
