/**
 * The one place AgentDeck talks to the desktop it is running on.
 *
 * Clipboard, screenshot and dictation all need Windows APIs that Node has no
 * binding for, so they go through PowerShell. Keeping that in a single seam
 * means the adapters above it are ordinary testable code, and the parts that
 * genuinely cannot run in CI — a display, a microphone, a foreground window —
 * are confined to this file.
 *
 * Scripts are passed as an argument array with `shell: false` and are never
 * built by interpolating user data: what varies is passed in the environment,
 * where it cannot become code.
 */

import { execFile } from "node:child_process";
import { AgentDeckError } from "../../domain/errors.js";
import type { Logger } from "../../infrastructure/logger.js";

export interface HostShellResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Runs a script on the host.
 *
 * @param variables Values the script reads from the environment. They are never
 * concatenated into the script text.
 */
export type HostShell = (
	script: string,
	options: { timeoutMs: number; variables?: Readonly<Record<string, string>> },
) => Promise<HostShellResult>;

export interface PowerShellOptions {
	executable?: string;
	logger?: Logger;
}

/**
 * PowerShell, non-interactive and profile-free.
 *
 * `-NoProfile` matters beyond speed: a user profile can redefine cmdlets, and a
 * redefined `Get-Clipboard` is not something the plugin should inherit.
 */
export function createPowerShell(options: PowerShellOptions = {}): HostShell {
	const executable = options.executable ?? "powershell.exe";
	const logger = options.logger?.child("host");

	return (script, { timeoutMs, variables }) =>
		new Promise<HostShellResult>((resolve, reject) => {
			execFile(
				executable,
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
				{
					timeout: timeoutMs,
					windowsHide: true,
					maxBuffer: 8 * 1024 * 1024,
					env: { ...process.env, ...variables },
				},
				(error, stdout, stderr) => {
					if (error === null) {
						resolve({ stdout, stderr, code: 0 });
						return;
					}
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						reject(new AgentDeckError("CLI_NOT_FOUND", `PowerShell not found: ${executable}`));
						return;
					}
					const exitCode = typeof error.code === "number" ? error.code : 1;
					// Never the output: it can be clipboard contents (instructions §11).
					logger?.debug(`host script exited with ${exitCode}`);
					resolve({ stdout, stderr, code: exitCode });
				},
			);
		});
}

/** True on the platform these adapters are written for (design §2 — Windows MVP). */
export function isWindows(platform: string = process.platform): boolean {
	return platform === "win32";
}

export function requireWindows(feature: string, platform: string = process.platform): void {
	if (!isWindows(platform)) {
		throw new AgentDeckError("NOT_CONFIGURED", `${feature} needs Windows.`);
	}
}
