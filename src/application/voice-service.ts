/**
 * Push-to-Talk — design §13.4, §22.3.
 *
 *   Key Down → Recording → Touch Strip: LISTENING → Key Up → Transcribe → Target Action
 *
 * The target action is a prompt preset, which is how one mechanism covers all
 * three destinations design §13.4 lists (clipboard, steer the active agent, new
 * prompt) without a second routing table.
 *
 * §22.3 asks that the recording state be clearly shown and always answerable:
 * `state` is that answer, and it is published as a UI concern so the key and the
 * touch strip cannot disagree about whether the microphone is live.
 */

import type { VoiceInputProvider } from "../adapters/desktop/voice.js";
import { AgentDeckError, toAgentDeckError } from "../domain/errors.js";
import type { Unsubscribe } from "../domain/provider-events.js";
import type { ProviderId } from "../domain/usage.js";
import type { Logger } from "../infrastructure/logger.js";
import type { PromptRunResult, PromptService } from "./prompt-service.js";

export type VoiceState = "idle" | "listening" | "transcribing" | "unavailable";

export type VoiceListener = () => void;

export interface VoiceServiceOptions {
	logger?: Logger;
	provider?: VoiceInputProvider;
}

export class VoiceService {
	readonly #prompts: PromptService;
	readonly #provider: VoiceInputProvider | undefined;
	readonly #logger: Logger | undefined;
	readonly #listeners = new Set<VoiceListener>();
	#state: VoiceState = "idle";
	#lastError: AgentDeckError | undefined;

	public constructor(prompts: PromptService, options: VoiceServiceOptions = {}) {
		this.#prompts = prompts;
		this.#provider = options.provider;
		this.#logger = options.logger?.child("voice");
	}

	public subscribe(listener: VoiceListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public get available(): boolean {
		return this.#provider !== undefined;
	}

	public get providerName(): string | undefined {
		return this.#provider?.displayName;
	}

	public get state(): VoiceState {
		return this.#provider === undefined ? "unavailable" : this.#state;
	}

	public get lastError(): AgentDeckError | undefined {
		return this.#lastError;
	}

	/** Key down (design §13.4). */
	public async start(): Promise<void> {
		const provider = this.#requireProvider();
		if (this.#state !== "idle") {
			return;
		}
		this.#lastError = undefined;
		// Published before awaiting: LISTENING must appear on the press, not after
		// the microphone has finished opening.
		this.#set("listening");
		try {
			await provider.start();
		} catch (error) {
			this.#fail(error);
			throw this.#lastError ?? toAgentDeckError(error);
		}
	}

	/**
	 * Key up (design §13.4): stop, transcribe, then run the preset.
	 *
	 * Silence is not an error and not a prompt: with nothing recognised, this
	 * returns `undefined` rather than sending an empty turn.
	 */
	public async stopAndRun(
		presetId: string | undefined,
		options: { providerId?: ProviderId; cwd?: string } = {},
	): Promise<PromptRunResult | undefined> {
		const provider = this.#requireProvider();
		if (this.#state !== "listening") {
			throw new AgentDeckError("INTERRUPTED", "Nothing was being recorded.");
		}

		this.#set("transcribing");
		let text: string;
		try {
			const result = await provider.stop();
			text = result.text.trim();
			this.#logger?.info(`transcribed ${result.durationMs}ms of speech`);
		} catch (error) {
			this.#fail(error);
			throw this.#lastError ?? toAgentDeckError(error);
		}

		if (text.length === 0) {
			this.#set("idle");
			this.#logger?.info("nothing was recognised");
			return undefined;
		}

		try {
			// The transcript is the input; the preset supplies the framing and the
			// destination. It is never logged (instructions §11).
			return await this.#prompts.run(presetId, { ...options, text });
		} catch (error) {
			this.#fail(error);
			throw this.#lastError ?? toAgentDeckError(error);
		} finally {
			// Whether the prompt was sent or failed, the microphone is closed and
			// the deck must say so. `#set` is a no-op when nothing changed.
			this.#set("idle");
		}
	}

	/** Abandons a recording without sending anything. */
	public async cancel(): Promise<void> {
		if (this.#provider === undefined || this.#state !== "listening") {
			return;
		}
		try {
			await this.#provider.stop();
		} catch (error) {
			this.#logger?.debug("could not stop the recogniser cleanly", error);
		}
		this.#set("idle");
	}

	public dispose(): void {
		this.#listeners.clear();
	}

	#requireProvider(): VoiceInputProvider {
		if (this.#provider === undefined) {
			throw new AgentDeckError("NOT_CONFIGURED", "No voice input provider is configured.");
		}
		return this.#provider;
	}

	#fail(error: unknown): void {
		this.#lastError = toAgentDeckError(error);
		this.#logger?.warn(`voice input failed: ${this.#lastError.code}`);
		this.#set("idle");
	}

	#set(state: VoiceState): void {
		if (this.#state === state) {
			return;
		}
		this.#state = state;
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				this.#logger?.warn("voice listener failed", error);
			}
		}
	}
}
