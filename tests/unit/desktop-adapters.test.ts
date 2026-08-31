/**
 * The desktop adapters — design §15, §22.4, instructions §11.
 *
 * The host shell itself cannot run here: there is no Windows, no display and no
 * clipboard in CI. What *is* testable is everything around it — the platform
 * guard, the cap, the temporary file's lifetime, and that no captured content
 * reaches a log line — so that is what these cover. The PowerShell scripts
 * themselves remain unverified until the device test.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WindowsClipboard } from "@/adapters/desktop/clipboard.js";
import { isWindows, requireWindows, type HostShell } from "@/adapters/desktop/host-shell.js";
import { WindowsScreenshot } from "@/adapters/desktop/screenshot.js";
import { SystemSpeechVoiceProvider } from "@/adapters/desktop/voice.js";
import { MAX_INPUT_CHARACTERS } from "@/domain/prompt.js";
import { createLogger, type LogSink } from "@/infrastructure/logger.js";

function recordingSink(): { sink: LogSink; lines: string[] } {
	const lines: string[] = [];
	const push = (message: string): void => void lines.push(message);
	return { sink: { error: push, warn: push, info: push, debug: push }, lines };
}

const ok =
	(stdout: string): HostShell =>
	async () => ({ stdout, stderr: "", code: 0 });

const fails: HostShell = async () => ({ stdout: "", stderr: "boom", code: 1 });

describe("platform guard", () => {
	it("recognises the MVP target", () => {
		expect(isWindows("win32")).toBe(true);
		expect(isWindows("linux")).toBe(false);
	});

	it("reports NOT_CONFIGURED elsewhere, so a key shows SETUP", () => {
		expect(() => requireWindows("Clipboard input", "darwin")).toThrow(
			expect.objectContaining({ code: "NOT_CONFIGURED" }),
		);
	});
});

describe("WindowsClipboard", () => {
	const options = { platform: "win32" as const };

	it("reads the clipboard, dropping the pipeline's trailing newline", async () => {
		const clipboard = new WindowsClipboard({ ...options, shell: ok("const x = 1;\r\n") });
		await expect(clipboard.read()).resolves.toBe("const x = 1;");
	});

	it("caps enormous content (design §15.2)", async () => {
		const clipboard = new WindowsClipboard({ ...options, shell: ok("x".repeat(MAX_INPUT_CHARACTERS + 500)) });
		const value = await clipboard.read();
		expect(value.length).toBeLessThan(MAX_INPUT_CHARACTERS + 100);
		expect(value).toContain("truncated by AgentDeck");
	});

	it("passes the copy delay through the environment, never into the script", async () => {
		const shell = vi.fn(ok("selected"));
		const clipboard = new WindowsClipboard({ ...options, shell, copyDelayMs: 250 });

		await clipboard.readSelection();

		const [script, passed] = shell.mock.calls[0] ?? [];
		expect(passed?.variables).toEqual({ AGENTDECK_COPY_DELAY_MS: "250" });
		expect(script).not.toContain("250");
	});

	it("refuses to run off Windows", async () => {
		const clipboard = new WindowsClipboard({ platform: "linux", shell: ok("x") });
		await expect(clipboard.read()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
	});

	it("never puts clipboard content in a log line (instructions §11)", async () => {
		const { sink, lines } = recordingSink();
		const logger = createLogger({ sink, level: "debug" });
		const clipboard = new WindowsClipboard({ ...options, logger, shell: fails });

		await expect(clipboard.read()).rejects.toThrow();

		expect(lines.join("\n")).not.toContain("boom");
	});
});

describe("WindowsScreenshot", () => {
	it("writes into a fresh directory and hands back the means to remove it", async () => {
		const shell = vi.fn(ok(""));
		const capture = new WindowsScreenshot({ platform: "win32", shell });

		const shot = await capture.capture("active-window");

		expect(shot.path.endsWith("capture.png")).toBe(true);
		const [, passed] = shell.mock.calls[0] ?? [];
		expect(passed?.variables).toMatchObject({ AGENTDECK_SHOT_MODE: "active-window" });
		// The destination is passed in, not interpolated into the script.
		expect(passed?.variables?.AGENTDECK_SHOT_PATH).toBe(shot.path);

		await shot.dispose();
		await expect(shot.dispose()).resolves.toBeUndefined();
	});

	it("leaves nothing behind when the capture fails (design §22.4)", async () => {
		const root = mkdtempSync(join(tmpdir(), "agentdeck-shot-root-"));
		try {
			const capture = new WindowsScreenshot({ platform: "win32", shell: fails, directory: root });

			await expect(capture.capture("full-screen")).rejects.toMatchObject({ code: "UNKNOWN" });

			// The adapter created a directory for the capture; a failed capture must
			// not leave it there.
			expect(readdirSync(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("removes the directory, not just the file, on dispose", async () => {
		const root = mkdtempSync(join(tmpdir(), "agentdeck-shot-root-"));
		try {
			const capture = new WindowsScreenshot({ platform: "win32", shell: ok(""), directory: root });
			const shot = await capture.capture("full-screen");
			expect(readdirSync(root)).toHaveLength(1);

			await shot.dispose();

			expect(readdirSync(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to run off Windows", async () => {
		const capture = new WindowsScreenshot({ platform: "linux", shell: ok("") });
		await expect(capture.capture("full-screen")).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
	});
});

describe("SystemSpeechVoiceProvider", () => {
	function deadRecogniser(exit: { code: number | null; error?: unknown }) {
		return {
			pid: 1,
			stdin: new Writable({ write: (_chunk, _encoding, done) => done() }),
			stdout: Readable.from([]),
			stderr: Readable.from([]),
			exited: Promise.resolve({ ...exit, signal: null }),
			running: false,
			shutdown: async () => ({ ...exit, signal: null }),
		};
	}

	function liveRecogniser(phrases: string[]) {
		return {
			pid: 1,
			stdin: new Writable({ write: (_chunk, _encoding, done) => done() }),
			stdout: Readable.from([`${phrases.join("\n")}\n`]),
			stderr: Readable.from([]),
			exited: new Promise<never>(() => {}),
			running: true,
			shutdown: async () => ({ code: 0, signal: null }),
		};
	}

	it("reports a recogniser that exited instead of calling it silence", async () => {
		// No microphone, or System.Speech missing: the script throws and exits. The
		// deck must not answer that with "nothing was recognised".
		const provider = new SystemSpeechVoiceProvider({
			platform: "win32",
			spawn: () => deadRecogniser({ code: 1 }) as never,
		});

		await provider.start();
		await vi.waitFor(() => expect(provider.recording).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 20));

		await expect(provider.stop()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
	});

	it("still returns whatever it did recognise before dying", async () => {
		const child = {
			...deadRecogniser({ code: 1 }),
			stdout: Readable.from(["check the parser\n"]),
		};
		const provider = new SystemSpeechVoiceProvider({
			platform: "win32",
			spawn: () => child as never,
		});

		await provider.start();
		await new Promise((resolve) => setTimeout(resolve, 20));

		await expect(provider.stop()).resolves.toMatchObject({ text: "check the parser" });
	});

	it("terminates quickly, because a key release must not wait (design §27)", async () => {
		let grace: number | undefined;
		const provider = new SystemSpeechVoiceProvider({
			platform: "win32",
			spawn: (options) => {
				grace = options.shutdownGraceMs;
				return liveRecogniser(["hello"]) as never;
			},
		});

		await provider.start();

		// The script polls rather than reading stdin, so closing stdin does not
		// stop it; the default three-second grace would be three seconds of
		// nothing happening after the user let go.
		expect(grace).toBeLessThanOrEqual(500);
	});

	it("refuses to record off Windows", async () => {
		const provider = new SystemSpeechVoiceProvider({ platform: "linux" });
		await expect(provider.start()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
	});

	it("reports nothing to stop when it was not recording", async () => {
		const provider = new SystemSpeechVoiceProvider({ platform: "win32" });
		await expect(provider.stop()).rejects.toMatchObject({ code: "INTERRUPTED" });
	});
});
