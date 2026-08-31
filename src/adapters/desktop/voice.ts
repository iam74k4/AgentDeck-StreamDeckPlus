/**
 * Voice input — design §13, §22.3.
 *
 * ```ts
 * interface VoiceInputProvider {
 *   start(): Promise<void>;
 *   stop(): Promise<VoiceResult>;
 * }
 * ```
 *
 * The shipped implementation is **local**: Windows' own speech recogniser via
 * `System.Speech`, running in a child process that reads the default microphone
 * and prints each recognised phrase. Nothing is sent anywhere (§22.3 "Local STT
 * 利用時は外部送信しない"), and there is no remote option to configure, so the
 * §22.3 disclosure requirement for remote STT does not arise.
 *
 * Raw audio never leaves the recogniser and is never written or logged
 * (instructions §11 "Voice raw data"). Only the recognised text is returned, to
 * the caller and nowhere else.
 */

import { AgentDeckError } from "../../domain/errors.js";
import type { Logger } from "../../infrastructure/logger.js";
import { spawnManagedProcess, type ManagedProcess } from "../../infrastructure/process-manager.js";
import { clampInput } from "../../domain/prompt.js";
import { requireWindows } from "./host-shell.js";

export interface VoiceResult {
	text: string;
	durationMs: number;
}

/** Design §13.1. */
export interface VoiceInputProvider {
	readonly displayName: string;
	start(): Promise<void>;
	stop(): Promise<VoiceResult>;
	/** Design §22.3 — the recording state must always be answerable. */
	readonly recording: boolean;
}

/**
 * Recognises continuously and prints one line per phrase.
 *
 * `RecognizeAsync(Multiple)` keeps going until the process is stopped, which is
 * what push-to-talk needs: the user holds the key and speaks for as long as they
 * like. `[Console]::Out.Flush()` matters — without it a short utterance can sit
 * in the buffer until the process dies.
 */
const RECOGNISE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$engine.SetInputToDefaultAudioDevice()
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -Action {
  [Console]::Out.WriteLine($EventArgs.Result.Text)
  [Console]::Out.Flush()
} | Out-Null
$engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
while ($true) { Start-Sleep -Milliseconds 200 }
`.trim();

export interface SystemSpeechVoiceOptions {
	logger?: Logger;
	executable?: string;
	/** Test seam. */
	spawn?: typeof spawnManagedProcess;
	/** Test seam. */
	platform?: string;
	/** Test seam. */
	now?: () => number;
}

export class SystemSpeechVoiceProvider implements VoiceInputProvider {
	public readonly displayName = "Windows Speech (local)";

	readonly #logger: Logger | undefined;
	readonly #executable: string;
	readonly #spawn: typeof spawnManagedProcess;
	readonly #platform: string;
	readonly #now: () => number;

	#process: ManagedProcess | undefined;
	#transcript: string[] = [];
	#startedAt = 0;

	public constructor(options: SystemSpeechVoiceOptions = {}) {
		this.#logger = options.logger?.child("voice");
		this.#executable = options.executable ?? "powershell.exe";
		this.#spawn = options.spawn ?? spawnManagedProcess;
		this.#platform = options.platform ?? process.platform;
		this.#now = options.now ?? (() => Date.now());
	}

	public get recording(): boolean {
		return this.#process !== undefined;
	}

	public async start(): Promise<void> {
		requireWindows("Voice input", this.#platform);
		if (this.#process !== undefined) {
			// A second key-down before key-up is a stutter, not a new recording.
			return;
		}

		this.#transcript = [];
		this.#startedAt = this.#now();
		const child = this.#spawn({
			command: this.#executable,
			args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", RECOGNISE_SCRIPT],
			...(this.#logger === undefined ? {} : { logger: this.#logger }),
		});

		child.stdout.setEncoding("utf8");
		let buffered = "";
		child.stdout.on("data", (chunk: string) => {
			buffered += chunk;
			const lines = buffered.split(/\r?\n/);
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				const phrase = line.trim();
				if (phrase.length > 0) {
					this.#transcript.push(phrase);
				}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			// The recogniser's own diagnostics; never the recognised text.
			const text = chunk.trim();
			if (text.length > 0) {
				this.#logger?.debug("speech recogniser stderr");
			}
		});

		void child.exited.then((exit) => {
			if (this.#process === child && exit.error !== undefined) {
				this.#logger?.warn("speech recogniser could not start", exit.error);
			}
		});

		this.#process = child;
		this.#logger?.info("recording started");
	}

	public async stop(): Promise<VoiceResult> {
		const child = this.#process;
		if (child === undefined) {
			throw new AgentDeckError("INTERRUPTED", "Nothing was being recorded.");
		}
		this.#process = undefined;

		await child.shutdown();
		const durationMs = Math.max(0, this.#now() - this.#startedAt);
		const text = clampInput(this.#transcript.join(" ").trim());
		this.#transcript = [];

		// The length, never the words (instructions §11).
		this.#logger?.info(`recording stopped after ${durationMs}ms`);
		return { text, durationMs };
	}
}
