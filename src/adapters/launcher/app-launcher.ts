/**
 * App launcher — design §11.
 *
 * An Environment Utility, not a differentiator: it starts the tools the user
 * already has. Everything is spawned with an argument array and `shell: false`,
 * so a project path containing `&` or a quote is an argument and never a command.
 */

import { spawn } from "node:child_process";
import { AgentDeckError } from "../../domain/errors.js";
import { resolveExecutable } from "../../infrastructure/executable.js";
import type { Logger } from "../../infrastructure/logger.js";

export interface LaunchContext {
	/** Absolute path of the active project, when there is one. */
	projectPath?: string;
}

export interface AppLauncher {
	readonly id: string;
	readonly displayName: string;
	isInstalled(): Promise<boolean>;
	launch(context?: LaunchContext): Promise<void>;
}

export interface AppDefinition {
	id: string;
	displayName: string;
	/** Executable name resolved on PATH, or an absolute path. */
	command: string;
	/** Fixed arguments, before any project argument. */
	args?: readonly string[];
	/**
	 * How the project path is passed. `argument` appends it, `cwd` starts the
	 * process there, `none` ignores it.
	 */
	project?: "argument" | "cwd" | "none";
}

/**
 * The apps instructions §4 names, plus whatever the user configures.
 *
 * Windows is the MVP target; `code` and `wt` are the names those tools put on
 * PATH there, and both work unchanged on other platforms when present.
 */
export const BUILT_IN_APPS: readonly AppDefinition[] = [
	{ id: "vscode", displayName: "VS Code", command: "code", project: "argument" },
	{ id: "terminal", displayName: "Windows Terminal", command: "wt", project: "cwd" },
	{ id: "codex", displayName: "Codex CLI", command: "codex", project: "cwd" },
	{ id: "claude", displayName: "Claude Code", command: "claude", project: "cwd" },
];

export interface ProcessAppLauncherOptions {
	definition: AppDefinition;
	logger?: Logger;
	env?: NodeJS.ProcessEnv;
	/** Test seams. */
	resolve?: typeof resolveExecutable;
	spawnProcess?: typeof spawn;
}

export class ProcessAppLauncher implements AppLauncher {
	readonly #definition: AppDefinition;
	readonly #logger: Logger | undefined;
	readonly #env: NodeJS.ProcessEnv | undefined;
	readonly #resolve: typeof resolveExecutable;
	readonly #spawn: typeof spawn;

	public constructor(options: ProcessAppLauncherOptions) {
		this.#definition = options.definition;
		this.#logger = options.logger?.child("launcher");
		this.#env = options.env;
		this.#resolve = options.resolve ?? resolveExecutable;
		this.#spawn = options.spawnProcess ?? spawn;
	}

	public get id(): string {
		return this.#definition.id;
	}

	public get displayName(): string {
		return this.#definition.displayName;
	}

	public async isInstalled(): Promise<boolean> {
		return this.#resolvedCommand() !== undefined;
	}

	public async launch(context: LaunchContext = {}): Promise<void> {
		const command = this.#resolvedCommand();
		if (command === undefined) {
			throw new AgentDeckError("CLI_NOT_FOUND", `${this.displayName} is not installed.`);
		}

		const mode = this.#definition.project ?? "none";
		const args = [...(this.#definition.args ?? [])];
		if (mode === "argument" && context.projectPath !== undefined) {
			args.push(context.projectPath);
		}
		const cwd = mode === "cwd" ? context.projectPath : undefined;

		try {
			const child = this.#spawn(command, args, {
				...(cwd === undefined ? {} : { cwd }),
				...(this.#env === undefined ? {} : { env: this.#env }),
				// The launched app outlives the plugin, and must not hold it open.
				detached: true,
				stdio: "ignore",
				windowsHide: false,
				shell: false,
			});
			child.on("error", (error) => this.#logger?.warn(`${this.displayName} failed to start`, error));
			child.unref();
		} catch (error) {
			throw new AgentDeckError("PROVIDER_OFFLINE", `Could not start ${this.displayName}.`, { cause: error });
		}
	}

	#resolvedCommand(): string | undefined {
		return this.#resolve(this.#definition.command, this.#env === undefined ? {} : { env: this.#env });
	}
}

export interface LauncherRegistryOptions {
	definitions?: readonly AppDefinition[];
	logger?: Logger;
	env?: NodeJS.ProcessEnv;
	create?: (definition: AppDefinition) => AppLauncher;
}

/** Holds the built-in apps plus any the user defines in the Property Inspector. */
export class LauncherRegistry {
	readonly #launchers = new Map<string, AppLauncher>();
	readonly #create: (definition: AppDefinition) => AppLauncher;

	public constructor(options: LauncherRegistryOptions = {}) {
		const { logger, env } = options;
		this.#create =
			options.create ??
			((definition) =>
				new ProcessAppLauncher({
					definition,
					...(logger === undefined ? {} : { logger }),
					...(env === undefined ? {} : { env }),
				}));

		for (const definition of options.definitions ?? BUILT_IN_APPS) {
			this.register(definition);
		}
	}

	public register(definition: AppDefinition): AppLauncher {
		const launcher = this.#create(definition);
		this.#launchers.set(launcher.id, launcher);
		return launcher;
	}

	public get(id: string): AppLauncher | undefined {
		return this.#launchers.get(id);
	}

	public list(): AppLauncher[] {
		return [...this.#launchers.values()];
	}

	/** Resolves a built-in id, or builds a launcher for a user-supplied command. */
	public resolve(options: {
		appId?: string;
		command?: string;
		args?: readonly string[];
	}): AppLauncher | undefined {
		if (options.appId !== undefined && options.appId.length > 0) {
			const built = this.get(options.appId);
			if (built !== undefined) {
				return built;
			}
		}
		const command = options.command?.trim();
		if (command === undefined || command.length === 0) {
			return undefined;
		}
		return this.#create({
			id: `custom:${command}`,
			displayName: command,
			command,
			...(options.args === undefined ? {} : { args: options.args }),
			project: "cwd",
		});
	}
}
