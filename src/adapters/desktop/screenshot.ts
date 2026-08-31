/**
 * Screenshot capture — design §15.1, §22.4.
 *
 * Two rules from §22.4 shape this: capture is never automatic, and the temporary
 * file lives as briefly as possible. `capture()` therefore hands back a path
 * together with the means to delete it, and every caller deletes it once the
 * agent has read it — including when the send fails.
 *
 * The image itself never reaches a log line (instructions §11); only the mode
 * and the outcome do.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDeckError } from "../../domain/errors.js";
import type { Logger } from "../../infrastructure/logger.js";
import { createPowerShell, requireWindows, type HostShell } from "./host-shell.js";

export type ScreenshotMode = "active-window" | "full-screen";

export interface Screenshot {
	path: string;
	/** Removes the file. Safe to call twice. */
	dispose(): Promise<void>;
}

export interface ScreenshotCapture {
	capture(mode: ScreenshotMode): Promise<Screenshot>;
}

/**
 * `GetWindowRect` on the foreground window, then a straight `CopyFromScreen`.
 *
 * The C# is inline because there is no Node binding for either call. Nothing in
 * it is built from user data: the destination path and the mode arrive through
 * the environment.
 */
const CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# Without this the process sees virtualised coordinates on a scaled display, and
# the capture comes back cropped to the top-left fraction of the window.
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class AgentDeckDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][AgentDeckDpi]::SetProcessDPIAware()
if ($env:AGENTDECK_SHOT_MODE -eq 'active-window') {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentDeckWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
}
'@
  $rect = New-Object AgentDeckWindow+Rect
  $handle = [AgentDeckWindow]::GetForegroundWindow()
  if (-not [AgentDeckWindow]::GetWindowRect($handle, [ref]$rect)) { throw 'no foreground window' }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw 'foreground window has no area' }
  $origin = New-Object System.Drawing.Point $rect.Left, $rect.Top
  $size = New-Object System.Drawing.Size $width, $height
} else {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $origin = New-Object System.Drawing.Point $bounds.Left, $bounds.Top
  $size = New-Object System.Drawing.Size $bounds.Width, $bounds.Height
}
$bitmap = New-Object System.Drawing.Bitmap $size.Width, $size.Height
try {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($origin, [System.Drawing.Point]::Empty, $size)
  } finally { $graphics.Dispose() }
  $bitmap.Save($env:AGENTDECK_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $bitmap.Dispose() }
`.trim();

export interface WindowsScreenshotOptions {
	logger?: Logger;
	timeoutMs?: number;
	/** Test seam. */
	shell?: HostShell;
	/** Test seam. */
	platform?: string;
	/** Test seam: where the temporary directory is created. */
	directory?: string;
}

export class WindowsScreenshot implements ScreenshotCapture {
	readonly #shell: HostShell;
	readonly #timeoutMs: number;
	readonly #platform: string;
	readonly #directory: string | undefined;
	readonly #logger: Logger | undefined;

	public constructor(options: WindowsScreenshotOptions = {}) {
		this.#shell =
			options.shell ?? createPowerShell({ ...(options.logger ? { logger: options.logger } : {}) });
		this.#timeoutMs = options.timeoutMs ?? 15_000;
		this.#platform = options.platform ?? process.platform;
		this.#directory = options.directory;
		this.#logger = options.logger?.child("screenshot");
	}

	public async capture(mode: ScreenshotMode): Promise<Screenshot> {
		requireWindows("Screenshot capture", this.#platform);

		const directory = await mkdtemp(join(this.#directory ?? tmpdir(), "agentdeck-shot-"));
		const path = join(directory, "capture.png");
		const dispose = async (): Promise<void> => {
			await rm(directory, { recursive: true, force: true });
		};

		try {
			const result = await this.#shell(CAPTURE_SCRIPT, {
				timeoutMs: this.#timeoutMs,
				variables: { AGENTDECK_SHOT_PATH: path, AGENTDECK_SHOT_MODE: mode },
			});
			if (result.code !== 0) {
				this.#logger?.debug(`capture failed with ${result.code}`);
				throw new AgentDeckError("UNKNOWN", `Could not capture the ${mode.replace("-", " ")}.`);
			}
		} catch (error) {
			// Never leave a file behind on the failure path.
			await dispose();
			throw error;
		}

		this.#logger?.info(`captured ${mode}`);
		return { path, dispose };
	}
}
