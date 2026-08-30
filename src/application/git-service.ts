/**
 * Git service — design §16.3.
 *
 * Caches one status per repository path and coalesces concurrent reads, mirroring
 * the usage service's single-flight rule so several actions watching the same
 * project cost one `git status`. Polling is low frequency and only runs for paths
 * that something is actually watching.
 */

import type { Unsubscribe } from "../domain/provider-events.js";
import { toAgentDeckError, type AgentDeckErrorCode } from "../domain/errors.js";
import type { GitStatus } from "../domain/git.js";
import type { Logger } from "../infrastructure/logger.js";
import { scheduleInterval, type ScheduledTask } from "../infrastructure/scheduler.js";
import { SingleFlight } from "../infrastructure/single-flight.js";
import type { GitAdapter } from "../adapters/git/git-adapter.js";

export interface GitStatusEntry {
	path: string;
	status?: GitStatus;
	errorCode?: AgentDeckErrorCode;
	fetchedAt: Date;
}

export type GitListener = (entry: GitStatusEntry) => void;

export interface GitServiceOptions {
	logger?: Logger;
	pollIntervalMs?: number;
	now?: () => Date;
}

export class GitService {
	readonly #adapter: GitAdapter;
	readonly #cache = new Map<string, GitStatusEntry>();
	readonly #listeners = new Set<GitListener>();
	readonly #singleFlight = new SingleFlight<string>();
	readonly #watchers = new Map<string, number>();
	readonly #logger: Logger | undefined;
	readonly #pollIntervalMs: number;
	readonly #now: () => Date;
	#poll: ScheduledTask | undefined;

	public constructor(adapter: GitAdapter, options: GitServiceOptions = {}) {
		this.#adapter = adapter;
		this.#logger = options.logger?.child("git");
		this.#pollIntervalMs = options.pollIntervalMs ?? 20_000;
		this.#now = options.now ?? (() => new Date());
	}

	public subscribe(listener: GitListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public get(path: string): GitStatusEntry | undefined {
		return this.#cache.get(path);
	}

	/** Registers interest in a path; polling starts with the first watcher. */
	public watch(path: string): Unsubscribe {
		this.#watchers.set(path, (this.#watchers.get(path) ?? 0) + 1);
		this.#ensurePolling();
		void this.refresh(path);

		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const count = (this.#watchers.get(path) ?? 1) - 1;
			if (count <= 0) {
				this.#watchers.delete(path);
			} else {
				this.#watchers.set(path, count);
			}
			if (this.#watchers.size === 0) {
				this.#poll?.stop();
				this.#poll = undefined;
			}
		};
	}

	public refresh(path: string): Promise<GitStatusEntry> {
		return this.#singleFlight.run(path, async () => {
			let entry: GitStatusEntry;
			try {
				entry = { path, status: await this.#adapter.getStatus(path), fetchedAt: this.#now() };
			} catch (error) {
				entry = { path, errorCode: toAgentDeckError(error).code, fetchedAt: this.#now() };
			}
			this.#cache.set(path, entry);
			this.#notify(entry);
			return entry;
		});
	}

	/** Design §16.3 — an agent event is a better refresh trigger than a timer. */
	public refreshWatched(): void {
		for (const path of this.#watchers.keys()) {
			void this.refresh(path);
		}
	}

	public dispose(): void {
		this.#poll?.stop();
		this.#poll = undefined;
		this.#listeners.clear();
		this.#watchers.clear();
		this.#cache.clear();
	}

	#ensurePolling(): void {
		this.#poll ??= scheduleInterval(this.#pollIntervalMs, () => this.refreshWatched(), {
			onError: (error) => this.#logger?.debug("git poll failed", error),
		});
	}

	#notify(entry: GitStatusEntry): void {
		for (const listener of this.#listeners) {
			try {
				listener(entry);
			} catch (error) {
				this.#logger?.warn("git listener failed", error);
			}
		}
	}
}
