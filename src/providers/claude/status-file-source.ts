/**
 * Reads the file the Claude Code bridge writes.
 *
 * Claude Code pushes; AgentDeck cannot pull. The file is therefore the whole
 * transport, and everything about staleness is decided here: a reading carries
 * the time the bridge captured it, and a reading older than the freshness window
 * is reported as stale rather than presented as current (design §17.3).
 */

import { readFile, stat } from "node:fs/promises";
import { AgentDeckError } from "../../domain/errors.js";
import type { Logger } from "../../infrastructure/logger.js";
import {
	CLAUDE_BRIDGE_FORMAT,
	type ClaudeStatusEnvelope,
	type ClaudeStatusPayload,
} from "./status-payload.js";

export interface ClaudeStatusReading {
	payload: ClaudeStatusPayload;
	capturedAt: Date;
	/** True once the reading is older than the configured freshness window. */
	stale: boolean;
}

export interface StatusFileSourceOptions {
	path: string;
	logger?: Logger;
	/**
	 * How long a reading stays current. Claude Code re-runs the status line on
	 * every assistant message, so silence past this window means no session is
	 * open — not that usage stopped changing.
	 */
	freshnessMs?: number;
	now?: () => Date;
	/** Test seam. */
	read?: (path: string) => Promise<string>;
}

export class ClaudeStatusFileSource {
	readonly #path: string;
	readonly #logger: Logger | undefined;
	readonly #freshnessMs: number;
	readonly #now: () => Date;
	readonly #read: (path: string) => Promise<string>;

	public constructor(options: StatusFileSourceOptions) {
		this.#path = options.path;
		this.#logger = options.logger?.child("claude-status");
		this.#freshnessMs = options.freshnessMs ?? 30 * 60_000;
		this.#now = options.now ?? (() => new Date());
		this.#read = options.read ?? ((path) => readFile(path, "utf8"));
	}

	public get path(): string {
		return this.#path;
	}

	/** True once the bridge has written at least one reading. */
	public async isConfigured(): Promise<boolean> {
		try {
			return (await stat(this.#path)).isFile();
		} catch {
			return false;
		}
	}

	public async read(): Promise<ClaudeStatusReading> {
		let text: string;
		try {
			text = await this.#read(this.#path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT") {
				// Not an error state so much as "the bridge has never run".
				throw new AgentDeckError(
					"NOT_AUTHENTICATED",
					"Claude Code has not reported yet. Configure the AgentDeck status-line bridge.",
				);
			}
			throw new AgentDeckError("PROVIDER_OFFLINE", `Cannot read ${this.#path}`, { cause: error });
		}

		let envelope: ClaudeStatusEnvelope;
		try {
			envelope = JSON.parse(text) as ClaudeStatusEnvelope;
		} catch (error) {
			throw new AgentDeckError("PROTOCOL_ERROR", "Claude status file is not valid JSON.", { cause: error });
		}

		if (typeof envelope !== "object" || envelope === null || typeof envelope.status !== "object") {
			throw new AgentDeckError("PROTOCOL_ERROR", "Claude status file has no status payload.");
		}
		if (envelope.v !== undefined && envelope.v !== CLAUDE_BRIDGE_FORMAT) {
			this.#logger?.warn(`unexpected bridge format ${String(envelope.v)}; reinstall the status-line bridge`);
		}

		const capturedAt = new Date(
			typeof envelope.capturedAt === "number" && Number.isFinite(envelope.capturedAt)
				? envelope.capturedAt
				: this.#now().getTime(),
		);

		return {
			payload: envelope.status ?? {},
			capturedAt,
			stale: this.#now().getTime() - capturedAt.getTime() > this.#freshnessMs,
		};
	}
}
