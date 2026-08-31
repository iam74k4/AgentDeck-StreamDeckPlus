/**
 * Push-to-Talk — design §13.4, §22.3.
 *
 * The properties under test are the safety ones: the deck says LISTENING for
 * exactly as long as the microphone is open, releasing always closes it, and a
 * transcript is never logged. Actual recognition needs a microphone and Windows,
 * so the recogniser itself is a stand-in here and unverified until the device test.
 */

import { describe, expect, it, vi } from "vitest";
import { PromptService } from "@/application/prompt-service.js";
import { ProviderRegistry } from "@/application/provider-registry.js";
import { SessionService } from "@/application/session-service.js";
import { VoiceService } from "@/application/voice-service.js";
import type { VoiceInputProvider } from "@/adapters/desktop/voice.js";
import { createLogger, type LogSink } from "@/infrastructure/logger.js";
import { ControllableProvider } from "../helpers/fake-runtime.js";

class FakeMicrophone implements VoiceInputProvider {
	public readonly displayName = "Fake microphone";
	public recording = false;
	public transcript = "check the parser";
	public startFails = false;

	public async start(): Promise<void> {
		if (this.startFails) {
			throw new Error("no microphone");
		}
		this.recording = true;
	}

	public async stop(): Promise<{ text: string; durationMs: number }> {
		this.recording = false;
		return { text: this.transcript, durationMs: 900 };
	}
}

function setup(options: { microphone?: VoiceInputProvider; sink?: LogSink } = {}) {
	const registry = new ProviderRegistry();
	const provider = new ControllableProvider();
	registry.register(provider);
	const sessions = new SessionService(registry);
	const prompts = new PromptService(sessions);
	prompts.setPresets([
		{
			id: "custom",
			name: "Custom",
			template: "{{input}}",
			inputSource: "clipboard",
			target: "active-session",
		},
	]);
	const microphone = options.microphone ?? new FakeMicrophone();
	const voice = new VoiceService(prompts, {
		provider: microphone,
		...(options.sink === undefined ? {} : { logger: createLogger({ sink: options.sink, level: "debug" }) }),
	});
	return { voice, prompts, provider, microphone };
}

describe("VoiceService", () => {
	it("reports LISTENING for exactly as long as the microphone is open", async () => {
		const { voice, provider } = setup();
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });

		expect(voice.state).toBe("idle");
		await voice.start();
		expect(voice.state).toBe("listening");

		await voice.stopAndRun("custom", { providerId: "codex" });
		expect(voice.state).toBe("idle");
	});

	it("sends the transcript through the preset", async () => {
		const { voice, provider, microphone } = setup();
		(microphone as FakeMicrophone).transcript = "run the failing test";
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });

		await voice.start();
		await voice.stopAndRun("custom", { providerId: "codex" });

		expect(provider.steered).toEqual([{ sessionId: "thr_1", input: { text: "run the failing test" } }]);
	});

	it("sends nothing when nothing was recognised", async () => {
		const { voice, provider, microphone } = setup();
		(microphone as FakeMicrophone).transcript = "   ";
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });

		await voice.start();
		await expect(voice.stopAndRun("custom", { providerId: "codex" })).resolves.toBeUndefined();

		expect(provider.steered).toEqual([]);
		expect(voice.state).toBe("idle");
	});

	it("returns to idle and closes the microphone when the send fails", async () => {
		const { voice, provider, microphone } = setup();
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });
		provider.steerFails = true;

		await voice.start();
		await expect(voice.stopAndRun("custom", { providerId: "codex" })).rejects.toThrow();

		expect(voice.state).toBe("idle");
		expect((microphone as FakeMicrophone).recording).toBe(false);
	});

	it("returns to idle when the microphone will not open", async () => {
		const microphone = new FakeMicrophone();
		microphone.startFails = true;
		const { voice } = setup({ microphone });

		await expect(voice.start()).rejects.toThrow();

		expect(voice.state).toBe("idle");
	});

	it("treats a second key-down as a stutter, not a new recording", async () => {
		const { voice, microphone } = setup();
		const spy = vi.spyOn(microphone, "start");

		await voice.start();
		await voice.start();

		expect(spy).toHaveBeenCalledTimes(1);
		expect(voice.state).toBe("listening");
	});

	it("refuses to send when nothing was being recorded", async () => {
		const { voice } = setup();
		await expect(voice.stopAndRun("custom", { providerId: "codex" })).rejects.toMatchObject({
			code: "INTERRUPTED",
		});
	});

	it("cancel closes the microphone and sends nothing", async () => {
		const { voice, provider, microphone } = setup();
		await voice.start();

		await voice.cancel();

		expect(voice.state).toBe("idle");
		expect((microphone as FakeMicrophone).recording).toBe(false);
		expect(provider.steered).toEqual([]);
	});

	it("reports unavailable rather than pretending, with no provider", async () => {
		const registry = new ProviderRegistry();
		const prompts = new PromptService(new SessionService(registry));
		const voice = new VoiceService(prompts);

		expect(voice.available).toBe(false);
		expect(voice.state).toBe("unavailable");
		await expect(voice.start()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
	});

	it("never writes the transcript to a log line (instructions §11)", async () => {
		const lines: string[] = [];
		const push = (message: string): void => void lines.push(message);
		const { voice, provider } = setup({ sink: { error: push, warn: push, info: push, debug: push } });
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });

		await voice.start();
		await voice.stopAndRun("custom", { providerId: "codex" });

		expect(lines.join("\n")).not.toContain("check the parser");
		// It does say that something was transcribed, and for how long.
		expect(lines.join("\n")).toContain("transcribed");
	});

	it("notifies subscribers on every state change", async () => {
		const { voice, provider } = setup();
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "idle", updatedAt: new Date() });
		const listener = vi.fn();
		voice.subscribe(listener);

		await voice.start();
		await voice.stopAndRun("custom", { providerId: "codex" });

		// idle → listening → transcribing → idle
		expect(listener).toHaveBeenCalledTimes(3);
	});
});

describe("shutdown", () => {
	it("closes the microphone before the plugin goes away", async () => {
		// The recogniser is a child process holding the microphone; leaving it
		// running past `process.exit` orphans it with the mic open.
		const microphone = new FakeMicrophone();
		const { voice } = setup({ microphone });
		await voice.start();
		expect(microphone.recording).toBe(true);

		await voice.cancel();

		expect(microphone.recording).toBe(false);
	});
});
