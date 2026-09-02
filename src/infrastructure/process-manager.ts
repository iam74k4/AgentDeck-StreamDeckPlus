/**
 * Child-process lifecycle — design §9.5, instructions §7.2 / §7.5.
 *
 * Owns spawn and shutdown only. Framing and JSON-RPC live one layer up, so this
 * module stays reusable for any stdio-based provider.
 *
 * Shutdown order (design §9.5): close stdin → terminate → force kill on timeout.
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { AgentDeckError } from "../domain/errors.js";
import type { Logger } from "./logger.js";

export interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	/**
	 * Set when the child never started — a missing or non-executable binary — so
	 * callers can report CLI_NOT_FOUND instead of a generic offline state.
	 */
	error?: AgentDeckError;
}

export interface SpawnOptions {
	command: string;
	args?: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	logger?: Logger;
	/** Milliseconds to wait after closing stdin before escalating. Default 3000. */
	shutdownGraceMs?: number;
	/** Overridable for tests; defaults to the host platform. */
	platform?: NodeJS.Platform;
}

export interface ManagedProcess {
	readonly pid: number | undefined;
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	/** Resolves when the child exits, whether cleanly or not. Never rejects. */
	readonly exited: Promise<ProcessExit>;
	readonly running: boolean;
	/** Graceful shutdown; resolves once the child has exited or has been killed. */
	shutdown(): Promise<ProcessExit>;
}

class NodeManagedProcess implements ManagedProcess {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #graceMs: number;
	readonly #logger: Logger | undefined;
	readonly #platform: NodeJS.Platform;
	readonly #exited: Promise<ProcessExit>;
	#running = true;
	#shutdownPromise: Promise<ProcessExit> | undefined;

	public constructor(
		child: ChildProcessWithoutNullStreams,
		command: string,
		graceMs: number,
		logger?: Logger,
		platform: NodeJS.Platform = process.platform,
	) {
		this.#child = child;
		this.#graceMs = graceMs;
		this.#logger = logger;
		this.#platform = platform;

		this.#exited = new Promise<ProcessExit>((resolve) => {
			const settle = (exit: ProcessExit): void => {
				this.#running = false;
				resolve(exit);
			};
			child.once("exit", (code, signal) => settle({ code, signal }));
			// `error` fires instead of `exit` when the binary cannot be started at all.
			child.once("error", (error) => {
				this.#logger?.warn("child process error", error);
				settle({ code: null, signal: null, error: spawnErrorToAgentDeckError(error, command) });
			});
		});

		// A crashed provider must never take the plugin down (instructions §7.5).
		child.stdin.on("error", (error) => this.#logger?.debug("stdin error", error));
		child.stdout.on("error", (error) => this.#logger?.debug("stdout error", error));
		child.stderr.on("error", (error) => this.#logger?.debug("stderr error", error));
	}

	public get pid(): number | undefined {
		return this.#child.pid;
	}

	public get stdin(): Writable {
		return this.#child.stdin;
	}

	public get stdout(): Readable {
		return this.#child.stdout;
	}

	public get stderr(): Readable {
		return this.#child.stderr;
	}

	public get exited(): Promise<ProcessExit> {
		return this.#exited;
	}

	public get running(): boolean {
		return this.#running;
	}

	public shutdown(): Promise<ProcessExit> {
		this.#shutdownPromise ??= this.#doShutdown();
		return this.#shutdownPromise;
	}

	async #doShutdown(): Promise<ProcessExit> {
		if (!this.#running) {
			return this.#exited;
		}

		try {
			this.#child.stdin.end();
		} catch (error) {
			this.#logger?.debug("failed to close stdin", error);
		}

		const graceful = await withTimeout(this.#exited, this.#graceMs);
		if (graceful !== TIMED_OUT) {
			return graceful;
		}

		this.#logger?.warn("provider process did not exit after stdin close; terminating");
		this.#signal("SIGTERM");

		const terminated = await withTimeout(this.#exited, this.#graceMs);
		if (terminated !== TIMED_OUT) {
			return terminated;
		}

		this.#logger?.warn("provider process did not respond to SIGTERM; force killing");
		this.#forceKill();
		return this.#exited;
	}

	#signal(signal: NodeJS.Signals): void {
		try {
			this.#child.kill(signal);
		} catch (error) {
			this.#logger?.debug(`failed to send ${signal}`, error);
		}
	}

	/**
	 * On Windows a batch launcher means the CLI is our *grandchild*, and killing
	 * `cmd.exe` leaves it running with the pipes still open. `taskkill /t` takes
	 * the tree, so a restart does not accumulate orphaned app-servers.
	 */
	#forceKill(): void {
		const pid = this.#child.pid;
		if (this.#platform !== "win32" || pid === undefined) {
			this.#signal("SIGKILL");
			return;
		}
		execFile("taskkill", ["/pid", String(pid), "/t", "/f"], (error) => {
			if (error !== null) {
				this.#logger?.debug("taskkill failed", error);
				this.#signal("SIGKILL");
			}
		});
	}
}

const TIMED_OUT = Symbol("timed-out");

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), ms);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/**
 * Spawns a child process.
 *
 * A missing or non-executable binary surfaces as `CLI_NOT_FOUND` on the
 * {@link ProcessExit} handed to {@link ManagedProcess.exited}, rather than as an
 * unhandled `error` event.
 */
export function spawnManagedProcess(options: SpawnOptions): ManagedProcess {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const invocation = buildSpawnInvocation(options.command, [...(options.args ?? [])], {
		platform,
		env,
	});

	const child = spawn(invocation.command, [...invocation.args], {
		cwd: options.cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		shell: false,
		...(invocation.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
	}) as ChildProcessWithoutNullStreams;

	// Errors keep naming the command the caller asked for, not the launcher.
	return new NodeManagedProcess(
		child,
		options.command,
		options.shutdownGraceMs ?? 3_000,
		options.logger,
		platform,
	);
}

export interface SpawnInvocation {
	command: string;
	args: readonly string[];
	windowsVerbatimArguments?: boolean;
}

const WINDOWS_BATCH_FILE = /\.(?:bat|cmd)$/i;
/** Everything `cmd.exe` treats as syntax rather than as text. */
const CMD_META_CHARS = /([()[\]{}%!^"`<>&|;, *?])/g;

/**
 * Decides what actually gets handed to `CreateProcess`.
 *
 * npm installs a CLI on Windows as `<name>.cmd`, and a batch file is not an
 * executable image: `CreateProcess` cannot run it, and Node refuses to spawn one
 * without a shell at all. So the common case — a CLI that works perfectly in the
 * user's terminal — has to be launched through `cmd.exe`.
 *
 * `cmd.exe /d /s /c` with an explicitly built, fully escaped command line is used
 * rather than `shell: true`, so the quoting happens here where the pieces are
 * known, instead of by string concatenation somewhere in between.
 */
export function buildSpawnInvocation(
	command: string,
	args: readonly string[],
	options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): SpawnInvocation {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32" || !WINDOWS_BATCH_FILE.test(command)) {
		return { command, args };
	}

	const env = options.env ?? process.env;
	const comspec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
	// The batch file is parsed by cmd a second time once it starts, so its
	// arguments carry one more layer of escaping than the command itself.
	const line = [escapeForCmd(command, false), ...args.map((argument) => escapeForCmd(argument, true))].join(
		" ",
	);

	// `/d` skips AutoRun scripts, `/s` makes cmd strip exactly the outer quotes.
	return {
		command: comspec,
		args: ["/d", "/s", "/c", `"${line}"`],
		windowsVerbatimArguments: true,
	};
}

function escapeForCmd(value: string, doubleEscape: boolean): string {
	// The C runtime's rules first: a backslash run only matters before a quote,
	// and a quote inside the value has to reach the child as data.
	const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	// Then cmd's own, which apply before the child ever sees a command line.
	const escaped = quoted.replace(CMD_META_CHARS, "^$1");
	return doubleEscape ? escaped.replace(CMD_META_CHARS, "^$1") : escaped;
}

/** Translates a Node spawn failure into the typed error surface (instructions §10). */
export function spawnErrorToAgentDeckError(error: unknown, command: string): AgentDeckError {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") {
		return new AgentDeckError("CLI_NOT_FOUND", `Executable not found: ${command}`, { cause: error });
	}
	if (code === "EACCES" || code === "EPERM" || code === "ENOEXEC") {
		return new AgentDeckError("CLI_NOT_FOUND", `Executable not runnable: ${command}`, { cause: error });
	}
	return new AgentDeckError("PROVIDER_OFFLINE", `Failed to start ${command}`, { cause: error });
}
