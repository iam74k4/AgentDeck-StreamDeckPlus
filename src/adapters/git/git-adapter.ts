/**
 * Git adapter — design §16, Spike C.
 *
 * Git is provider-independent core functionality: it never routes through an AI
 * provider. Reads only; AgentDeck does not mutate a repository.
 *
 * Failures are classified by exit status, never by matching git's stderr
 * (instructions §10). Git for Windows ships full localisation, so message text is
 * not something the plugin can branch on. The environment also pins `LC_ALL=C`
 * so anything that does reach a log line is stable across machines.
 */

import { execFile } from "node:child_process";
import { AgentDeckError } from "../../domain/errors.js";
import { parseGitNumstat, type DiffSummary, type GitStatus } from "../../domain/git.js";
import type { Logger } from "../../infrastructure/logger.js";
import { parseGitStatusPorcelainV2 } from "./git-status-parser.js";

export interface GitAdapter {
	isRepository(path: string): Promise<boolean>;
	getStatus(path: string): Promise<GitStatus>;
}

export interface GitCliAdapterOptions {
	executable?: string;
	logger?: Logger;
	timeoutMs?: number;
	/** Test seam. */
	run?: GitRunner;
}

export interface GitRunResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type GitRunner = (args: readonly string[], options: { timeoutMs: number }) => Promise<GitRunResult>;

export class GitCliAdapter implements GitAdapter {
	readonly #executable: string;
	readonly #logger: Logger | undefined;
	readonly #timeoutMs: number;
	readonly #run: GitRunner;

	public constructor(options: GitCliAdapterOptions = {}) {
		this.#executable = options.executable ?? "git";
		this.#logger = options.logger?.child("git");
		this.#timeoutMs = options.timeoutMs ?? 5_000;
		this.#run = options.run ?? this.#defaultRunner();
	}

	public async isRepository(path: string): Promise<boolean> {
		const result = await this.#run(["-C", path, "rev-parse", "--is-inside-work-tree"], {
			timeoutMs: this.#timeoutMs,
		});
		return result.code === 0 && result.stdout.trim() === "true";
	}

	public async getStatus(path: string): Promise<GitStatus> {
		const result = await this.#run(
			["-C", path, "status", "--porcelain=v2", "--branch", "--untracked-files=all"],
			{ timeoutMs: this.#timeoutMs },
		);

		if (result.code !== 0) {
			// One extra call, only on the failure path, to tell "not a repository"
			// apart from a genuine git failure — using exit status, not text.
			this.#logger?.debug(`git status exited with ${result.code}; classifying`);
			throw gitFailureToError(path, await this.isRepository(path));
		}

		const status = parseGitStatusPorcelainV2(result.stdout, path);
		const diff = await this.#readDiff(path, status.hasCommits);
		return diff === undefined ? status : { ...status, diff };
	}

	/**
	 * Design §16.2 — tracked changes against HEAD.
	 *
	 * Best effort on purpose: a branch and its counts are what the git key exists
	 * for, and losing the diff summary must not cost the user those. A repository
	 * with no commits has no HEAD to diff against, so it is skipped rather than
	 * spawning git to be told so.
	 *
	 * Untracked files are deliberately absent — `git diff` does not see them — and
	 * the deck already counts them separately as `U:`.
	 */
	async #readDiff(path: string, hasCommits: boolean): Promise<DiffSummary | undefined> {
		if (!hasCommits) {
			return undefined;
		}
		try {
			const result = await this.#run(["-C", path, "diff", "--numstat", "HEAD"], {
				timeoutMs: this.#timeoutMs,
			});
			if (result.code !== 0) {
				this.#logger?.debug(`git diff --numstat exited with ${result.code}`);
				return undefined;
			}
			return parseGitNumstat(result.stdout);
		} catch (error) {
			this.#logger?.debug("git diff --numstat failed", error);
			return undefined;
		}
	}

	#defaultRunner(): GitRunner {
		const executable = this.#executable;
		const logger = this.#logger;
		return (args, options) =>
			new Promise<GitRunResult>((resolve, reject) => {
				execFile(
					executable,
					[...args],
					{
						timeout: options.timeoutMs,
						windowsHide: true,
						maxBuffer: 4 * 1024 * 1024,
						// Deterministic output regardless of the user's git locale.
						env: { ...process.env, LC_ALL: "C", LANG: "C" },
					},
					(error, stdout, stderr) => {
						if (error === null) {
							resolve({ stdout, stderr, code: 0 });
							return;
						}
						const code = (error as NodeJS.ErrnoException).code;
						if (code === "ENOENT") {
							reject(new AgentDeckError("CLI_NOT_FOUND", `git executable not found: ${executable}`));
							return;
						}
						const exitCode = typeof error.code === "number" ? error.code : 1;
						logger?.debug(`git exited with ${exitCode}`);
						resolve({ stdout, stderr, code: exitCode });
					},
				);
			});
	}
}

/**
 * @param insideWorkTree Result of `git rev-parse --is-inside-work-tree` for the
 * same path, which answers "is this a repository at all" by exit status.
 */
export function gitFailureToError(path: string, insideWorkTree: boolean): AgentDeckError {
	return insideWorkTree
		? new AgentDeckError("UNKNOWN", `git status failed for ${path}`)
		: new AgentDeckError("GIT_NOT_REPOSITORY", `Not a git repository: ${path}`);
}
