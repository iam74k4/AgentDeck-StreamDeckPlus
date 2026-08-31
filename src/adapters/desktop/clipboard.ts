/**
 * Clipboard input — design §15.2, §22.4.
 *
 * Read on a key press and never on a timer: §22.4 requires a user action as the
 * trigger. Content is capped (§15.2) and never reaches a log line at any level
 * (instructions §11) — not even its length is interesting enough to risk the
 * habit.
 */

import { AgentDeckError } from "../../domain/errors.js";
import { clampInput } from "../../domain/prompt.js";
import type { Logger } from "../../infrastructure/logger.js";
import { createPowerShell, requireWindows, type HostShell } from "./host-shell.js";

export interface Clipboard {
	read(): Promise<string>;
	/**
	 * Copies the foreground window's selection, then reads it.
	 *
	 * Best effort by nature: it sends Ctrl+C and the focused application decides
	 * what that means. Callers treat an empty result as "nothing was selected".
	 */
	readSelection(): Promise<string>;
}

export interface WindowsClipboardOptions {
	logger?: Logger;
	timeoutMs?: number;
	/** Delay after Ctrl+C before reading, so the target application can respond. */
	copyDelayMs?: number;
	/** Test seam. */
	shell?: HostShell;
	/** Test seam. */
	platform?: string;
}

const READ_SCRIPT = "Get-Clipboard -Raw";

/**
 * Ctrl+C to the foreground window, then a pause before the read.
 *
 * `SendKeys` is the only way to reach the focused application from outside it;
 * there is no API that returns another process's selection.
 */
const COPY_SELECTION_SCRIPT = [
	"Add-Type -AssemblyName System.Windows.Forms",
	"[System.Windows.Forms.SendKeys]::SendWait('^c')",
	"Start-Sleep -Milliseconds $env:AGENTDECK_COPY_DELAY_MS",
	"Get-Clipboard -Raw",
].join("; ");

export class WindowsClipboard implements Clipboard {
	readonly #shell: HostShell;
	readonly #timeoutMs: number;
	readonly #copyDelayMs: number;
	readonly #platform: string;
	readonly #logger: Logger | undefined;

	public constructor(options: WindowsClipboardOptions = {}) {
		this.#shell =
			options.shell ?? createPowerShell({ ...(options.logger ? { logger: options.logger } : {}) });
		this.#timeoutMs = options.timeoutMs ?? 5_000;
		this.#copyDelayMs = options.copyDelayMs ?? 120;
		this.#platform = options.platform ?? process.platform;
		this.#logger = options.logger?.child("clipboard");
	}

	public async read(): Promise<string> {
		return this.#run(READ_SCRIPT, {});
	}

	public async readSelection(): Promise<string> {
		return this.#run(COPY_SELECTION_SCRIPT, {
			AGENTDECK_COPY_DELAY_MS: String(this.#copyDelayMs),
		});
	}

	async #run(script: string, variables: Record<string, string>): Promise<string> {
		requireWindows("Clipboard input", this.#platform);
		const result = await this.#shell(script, { timeoutMs: this.#timeoutMs, variables });
		if (result.code !== 0) {
			this.#logger?.debug(`clipboard read failed with ${result.code}`);
			throw new AgentDeckError("UNKNOWN", "Could not read the clipboard.");
		}
		// `Get-Clipboard -Raw` still appends the pipeline's trailing newline.
		return clampInput(result.stdout.replace(/\r?\n$/, ""));
	}
}
