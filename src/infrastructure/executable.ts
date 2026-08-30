/**
 * Executable resolution.
 *
 * Used to tell "the CLI is not installed" (`CLI_NOT_FOUND`) apart from "the CLI
 * is installed but failed" — design §17.3 shows these as different key states.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface ResolveOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}

function isExecutableFile(candidate: string): boolean {
	try {
		if (!statSync(candidate).isFile()) {
			return false;
		}
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Returns the resolved path of `command`, or `undefined` when it is not on PATH. */
export function resolveExecutable(command: string, options: ResolveOptions = {}): string | undefined {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const isWindows = platform === "win32";

	const extensions = isWindows
		? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0)
		: [""];

	const candidates = (base: string): string[] =>
		isWindows ? [base, ...extensions.map((ext) => `${base}${ext}`)] : [base];

	if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
		return candidates(command).find(isExecutableFile);
	}

	const pathValue = env.PATH ?? env.Path ?? "";
	for (const dir of pathValue.split(delimiter)) {
		if (dir.length === 0) {
			continue;
		}
		const found = candidates(join(dir, command)).find(isExecutableFile);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}
