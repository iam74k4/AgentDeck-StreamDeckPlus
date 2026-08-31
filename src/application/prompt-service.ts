/**
 * Prompt presets and the input they carry — design §14, §15.
 *
 * One place decides what a preset does: where its input comes from, how the
 * template is filled, and where the result goes. The actions above it only say
 * "run this preset", so the Prompt key, the Prompt dial, Push-to-Talk and
 * Screenshot → AI all behave the same way.
 *
 * Design §22.4 is structural here: nothing runs on a timer, every path starts
 * from a key press, and a screenshot's temporary file is deleted in a `finally`.
 */

import type { Clipboard } from "../adapters/desktop/clipboard.js";
import type { ScreenshotCapture, ScreenshotMode } from "../adapters/desktop/screenshot.js";
import { AgentDeckError, toAgentDeckError } from "../domain/errors.js";
import {
	clampInput,
	DEFAULT_PROMPT_PRESETS,
	isPromptPreset,
	renderPrompt,
	type PromptPreset,
} from "../domain/prompt.js";
import type { Unsubscribe } from "../domain/provider-events.js";
import type { AgentSession } from "../domain/session.js";
import type { ProviderId } from "../domain/usage.js";
import type { Logger } from "../infrastructure/logger.js";
import type { SessionService } from "./session-service.js";

/** Where a preset's result went, so the key can say what happened. */
export interface PromptRunResult {
	preset: PromptPreset;
	target: PromptPreset["target"];
	/** Present when the prompt reached an agent. */
	session?: AgentSession;
}

export interface PromptServiceOptions {
	logger?: Logger;
	clipboard?: Clipboard;
	screenshot?: ScreenshotCapture;
	screenshotMode?: ScreenshotMode;
	/** Where a `clipboard` target writes to; absent means that target is unavailable. */
	writeClipboard?: (text: string) => Promise<void>;
}

export type PromptListener = () => void;

export class PromptService {
	readonly #sessions: SessionService;
	readonly #logger: Logger | undefined;
	readonly #listeners = new Set<PromptListener>();
	readonly #options: PromptServiceOptions;
	#presets: PromptPreset[] = [...DEFAULT_PROMPT_PRESETS];
	#selectedIndex = 0;

	public constructor(sessions: SessionService, options: PromptServiceOptions = {}) {
		this.#sessions = sessions;
		this.#options = options;
		this.#logger = options.logger?.child("prompt");
	}

	public subscribe(listener: PromptListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public list(): readonly PromptPreset[] {
		return this.#presets;
	}

	/**
	 * Replaces the preset list, e.g. from the Property Inspector (design §14).
	 *
	 * An empty or unusable list falls back to the defaults rather than leaving the
	 * dial with nothing to select.
	 */
	public setPresets(presets: readonly unknown[]): void {
		const usable = presets.filter(isPromptPreset);
		this.#presets = usable.length > 0 ? usable : [...DEFAULT_PROMPT_PRESETS];
		this.#selectedIndex = Math.min(this.#selectedIndex, this.#presets.length - 1);
		this.#notify();
	}

	/** What the Prompt dial is pointing at. */
	public get selected(): PromptPreset | undefined {
		return this.#presets[this.#selectedIndex];
	}

	public get selectedIndex(): number {
		return this.#selectedIndex;
	}

	public rotate(delta: number): void {
		const count = this.#presets.length;
		if (count === 0) {
			return;
		}
		this.#selectedIndex = (((this.#selectedIndex + delta) % count) + count) % count;
		this.#notify();
	}

	public get(presetId: string | undefined): PromptPreset | undefined {
		if (presetId === undefined || presetId.length === 0) {
			return this.selected;
		}
		return this.#presets.find((preset) => preset.id === presetId);
	}

	/**
	 * Runs a preset.
	 *
	 * @param options.text Input the caller already has — dictated speech, or text
	 * typed into the Property Inspector. It replaces the preset's own input source.
	 */
	public async run(
		presetId: string | undefined,
		options: {
			providerId?: ProviderId;
			cwd?: string;
			text?: string;
			/** Overrides the default capture mode for this run (design §15.1). */
			screenshotMode?: ScreenshotMode;
		} = {},
	): Promise<PromptRunResult> {
		const preset = this.get(presetId);
		if (preset === undefined) {
			throw new AgentDeckError("NOT_CONFIGURED", "There is no prompt preset to run.");
		}

		const supplied = options.text?.trim();
		// A caller-supplied transcript stands in for the preset's input source: a
		// spoken instruction is the input, and re-reading the clipboard on top of
		// it would send something the user did not say.
		if (supplied !== undefined && supplied.length > 0) {
			return this.#dispatch(preset, renderPrompt(preset.template, clampInput(supplied)), [], options);
		}

		if (preset.inputSource === "screenshot") {
			return this.#runWithScreenshot(preset, options);
		}

		const captured = await this.#captureText(preset);
		return this.#dispatch(preset, renderPrompt(preset.template, captured), [], options);
	}

	async #runWithScreenshot(
		preset: PromptPreset,
		options: { providerId?: ProviderId; cwd?: string; screenshotMode?: ScreenshotMode },
	): Promise<PromptRunResult> {
		const capture = this.#options.screenshot;
		if (capture === undefined) {
			throw new AgentDeckError("NOT_CONFIGURED", "Screenshot capture is not available.");
		}
		const shot = await capture.capture(
			options.screenshotMode ?? this.#options.screenshotMode ?? "active-window",
		);
		try {
			return await this.#dispatch(preset, renderPrompt(preset.template, ""), [shot.path], options);
		} finally {
			// Design §22.4 — the temporary file does not outlive the send, whether
			// or not the send worked.
			try {
				await shot.dispose();
			} catch (error) {
				this.#logger?.debug("could not remove the screenshot", error);
			}
		}
	}

	async #captureText(preset: PromptPreset): Promise<string> {
		if (preset.inputSource === "none") {
			return "";
		}
		const clipboard = this.#options.clipboard;
		if (clipboard === undefined) {
			throw new AgentDeckError("NOT_CONFIGURED", "Clipboard input is not available.");
		}
		try {
			return preset.inputSource === "selection" ? await clipboard.readSelection() : await clipboard.read();
		} catch (error) {
			// The message never carries what was read (instructions §11).
			throw toAgentDeckError(error, "UNKNOWN");
		}
	}

	async #dispatch(
		preset: PromptPreset,
		text: string,
		imagePaths: readonly string[],
		options: { providerId?: ProviderId; cwd?: string },
	): Promise<PromptRunResult> {
		if (text.length === 0 && imagePaths.length === 0) {
			throw new AgentDeckError("NOT_CONFIGURED", "There was nothing to send.");
		}

		if (preset.target === "clipboard") {
			const write = this.#options.writeClipboard;
			if (write === undefined) {
				throw new AgentDeckError("NOT_CONFIGURED", "Writing to the clipboard is not available.");
			}
			await write(text);
			this.#logger?.info(`prompt "${preset.name}" copied to the clipboard`);
			return { preset, target: preset.target };
		}

		const session = await this.#sessions.send(
			{ text, ...(imagePaths.length === 0 ? {} : { imagePaths }) },
			{
				...(options.providerId === undefined ? {} : { providerId: options.providerId }),
				target: preset.target,
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			},
		);
		// The preset's name, never the prompt itself (instructions §11).
		this.#logger?.info(`prompt "${preset.name}" sent`);
		return { preset, target: preset.target, session };
	}

	public dispose(): void {
		this.#listeners.clear();
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				this.#logger?.warn("prompt listener failed", error);
			}
		}
	}
}
