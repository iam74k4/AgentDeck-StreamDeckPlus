/**
 * How a command reaches `CreateProcess` on Windows.
 *
 * npm installs a CLI as `<name>.cmd`, so "the CLI works in my terminal but the
 * deck says CLI?" is the normal failure here, not an exotic one: a batch file is
 * not an executable image, and Windows applies neither PATHEXT nor a shell on the
 * caller's behalf.
 */

import { describe, expect, it } from "vitest";
import { buildSpawnInvocation } from "@/infrastructure/process-manager.js";

const COMSPEC = String.raw`C:\WINDOWS\system32\cmd.exe`;

describe("spawn invocation", () => {
	it("leaves a real executable alone", () => {
		expect(buildSpawnInvocation("/usr/local/bin/codex", ["app-server"], { platform: "linux" })).toEqual({
			command: "/usr/local/bin/codex",
			args: ["app-server"],
		});
		expect(
			buildSpawnInvocation(String.raw`C:\tools\codex.exe`, ["app-server"], {
				platform: "win32",
				env: { ComSpec: COMSPEC },
			}),
		).toEqual({ command: String.raw`C:\tools\codex.exe`, args: ["app-server"] });
	});

	it("launches a Windows batch shim through cmd.exe", () => {
		const invocation = buildSpawnInvocation(
			String.raw`C:\Program Files\npm\codex.cmd`,
			["app-server", "--stdio"],
			{ platform: "win32", env: { ComSpec: COMSPEC } },
		);

		expect(invocation.command).toBe(COMSPEC);
		expect(invocation.windowsVerbatimArguments).toBe(true);
		expect(invocation.args).toEqual([
			"/d",
			"/s",
			"/c",
			String.raw`"^"C:\Program^ Files\npm\codex.cmd^" ^^^"app-server^^^" ^^^"--stdio^^^""`,
		]);
	});

	it("falls back to cmd.exe when ComSpec is not set", () => {
		const invocation = buildSpawnInvocation(String.raw`C:\npm\codex.cmd`, [], {
			platform: "win32",
			env: {},
		});
		expect(invocation.command).toBe("cmd.exe");
	});

	// The executable is a user setting and the arguments come from it, so nothing
	// in the line may be able to start a second command.
	it("escapes cmd syntax rather than passing it through", () => {
		const invocation = buildSpawnInvocation(String.raw`C:\npm\codex.cmd`, ["a & calc"], {
			platform: "win32",
			env: { ComSpec: COMSPEC },
		});
		const line = invocation.args[3] ?? "";

		expect(line).toContain(String.raw`^^^"a^^^ ^^^&^^^ calc^^^"`);
		// Every metacharacter in the line is caret-escaped; none stands on its own.
		expect(line.replace(/\^./g, "")).not.toMatch(/[&|<>]/);
	});
});
