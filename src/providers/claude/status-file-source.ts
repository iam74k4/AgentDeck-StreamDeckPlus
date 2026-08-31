/**
 * Reads the readings the Claude Code bridge writes.
 *
 * Claude Code pushes; AgentDeck cannot pull. The directory of per-session files
 * is therefore the whole transport, and everything about recency is decided
 * here: each reading carries the time the bridge captured it, the freshest wins,
 * and a reading past the freshness window is reported as stale rather than
 * presented as current (design §17.3).
 */

import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentDeckError } from "../../domain/errors.js";
import type { Logger } from "../../infrastructure/logger.js";
import { isClaudeStatusFilename } from "./bridge-path.js";
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
	/** Directory the bridge writes into. */
	dir: string;
	logger?: Logger;
	/**
	 * How long a reading stays current. Claude Code re-runs the status line on
	 * every assistant message, so silence past this window means no session is
	 * open — not that usage stopped changing.
	 */
	freshnessMs?: number;
	/** Readings older than this are deleted during a scan. */
	retentionMs?: number;
	now?: () => Date;
	/** Test seams; all filesystem access goes through these. */
	list?: (dir: string) => Promise<string[]>;
	read?: (path: string) => Promise<string>;
	remove?: (path: string) => Promise<void>;
}

export class ClaudeStatusFileSource {
	readonly #dir: string;
	readonly #logger: Logger | undefined;
	readonly #freshnessMs: number;
	readonly #retentionMs: number;
	readonly #now: () => Date;
	readonly #list: (dir: string) => Promise<string[]>;
	readonly #read: (path: string) => Promise<string>;
	readonly #remove: (path: string) => Promise<void>;

	public constructor(options: StatusFileSourceOptions) {
		this.#dir = options.dir;
		this.#logger = options.logger?.child("claude-status");
		this.#freshnessMs = options.freshnessMs ?? 30 * 60_000;
		this.#retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60_000;
		this.#now = options.now ?? (() => new Date());
		this.#list = options.list ?? ((dir) => readdir(dir));
		this.#read = options.read ?? ((path) => readFile(path, "utf8"));
		this.#remove = options.remove ?? ((path) => unlink(path));
	}

	public get dir(): string {
		return this.#dir;
	}

	/** True once the bridge has written at least one reading. */
	public async isConfigured(): Promise<boolean> {
		return (await this.#filenames()).length > 0;
	}

	/**
	 * Returns the most recent reading across every open Claude Code session,
	 * which is what "the agent I am currently working with" means on a deck.
	 */
	public async read(): Promise<ClaudeStatusReading> {
		const filenames = await this.#filenames();
		if (filenames.length === 0) {
			// Not an error state so much as "the bridge has never run".
			throw new AgentDeckError(
				"NOT_CONFIGURED",
				"Claude Code has not reported yet. Configure the AgentDeck status-line bridge.",
			);
		}

		let best: ClaudeStatusReading | undefined;
		let lastFailure: AgentDeckError | undefined;

		for (const name of filenames) {
			const path = join(this.#dir, name);
			let reading: ClaudeStatusReading;
			try {
				reading = this.#parse(await this.#read(path));
			} catch (error) {
				lastFailure = error instanceof AgentDeckError ? error : undefined;
				this.#logger?.debug(`ignoring unreadable reading ${name}`);
				continue;
			}

			// A session that stopped reporting a week ago is not coming back.
			if (this.#now().getTime() - reading.capturedAt.getTime() > this.#retentionMs) {
				void this.#remove(path).catch(() => undefined);
				continue;
			}
			if (best === undefined || reading.capturedAt.getTime() > best.capturedAt.getTime()) {
				best = reading;
			}
		}

		if (best === undefined) {
			throw (
				lastFailure ??
				new AgentDeckError("NOT_CONFIGURED", "No usable Claude reading in the bridge directory.")
			);
		}
		return best;
	}

	async #filenames(): Promise<string[]> {
		try {
			return (await this.#list(this.#dir)).filter(isClaudeStatusFilename);
		} catch {
			return [];
		}
	}

	#parse(text: string): ClaudeStatusReading {
		let envelope: ClaudeStatusEnvelope;
		try {
			envelope = JSON.parse(text) as ClaudeStatusEnvelope;
		} catch (error) {
			throw new AgentDeckError("PROTOCOL_ERROR", "Claude status file is not valid JSON.", { cause: error });
		}

		if (
			typeof envelope !== "object" ||
			envelope === null ||
			typeof envelope.status !== "object" ||
			envelope.status === null
		) {
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
