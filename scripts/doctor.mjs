/**
 * Preflight for a real Stream Deck +.
 *
 * Everything the plugin needs, checked in the order it would fail. The plugin
 * itself degrades quietly by design — a missing Codex CLI shows `CLI?` on a key
 * and nothing else — which is right on a deck and useless when you are trying to
 * work out why. This says what is wrong and what to do about it.
 *
 * Usage: npm run doctor
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_UUID = "com.agentdeck.streamdeck-plus";
const IS_WINDOWS = process.platform === "win32";

// ------------------------------------------------------------------- reporting

const OK = "ok";
const WARN = "warn";
const FAIL = "fail";

const MARKS = { [OK]: "  OK  ", [WARN]: " WARN ", [FAIL]: " FAIL " };
const results = [];

function report(status, title, detail, fix) {
	results.push({ status, title, detail, fix });
	console.log(`[${MARKS[status]}] ${title}${detail ? ` — ${detail}` : ""}`);
	if (fix && status !== OK) {
		for (const line of fix.split("\n")) {
			console.log(`          ${line}`);
		}
	}
}

function section(name) {
	console.log(`\n${name}`);
	console.log("-".repeat(name.length));
}

function run(command, args, { timeoutMs = 8000, env } = {}) {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{ timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...env } },
			(error, stdout, stderr) => {
				resolve({
					ok: error === null,
					code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
					missing: error !== null && error.code === "ENOENT",
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
				});
			},
		);
	});
}

// ------------------------------------------------------------------- the checks

function checkPlatform() {
	section("Platform");
	if (IS_WINDOWS) {
		report(OK, "Windows", `${process.platform} ${process.arch}`);
		return;
	}
	report(
		WARN,
		"Not Windows",
		`${process.platform}`,
		"Usage, sessions, git and approvals all work here.\n" +
			"Clipboard, screenshot and push-to-talk need Windows and will report SETUP.",
	);
}

function checkNode() {
	section("Node");
	const [major, minor] = process.versions.node.split(".").map(Number);
	const supported = major > 20 || (major === 20 && minor >= 5);
	report(
		supported ? OK : FAIL,
		"Node runtime",
		`v${process.versions.node}`,
		supported ? undefined : "The plugin needs Node 20.5.1 or newer. Install it and re-run.",
	);
}

function checkBuild() {
	section("Build");
	const plugin = join(ROOT, `${PLUGIN_UUID}.sdPlugin`, "bin", "plugin.js");
	const bridge = join(ROOT, `${PLUGIN_UUID}.sdPlugin`, "bin", "statusline.mjs");

	report(
		existsSync(plugin) ? OK : FAIL,
		"Plugin bundle",
		existsSync(plugin)
			? `built ${statSync(plugin).mtime.toISOString().slice(0, 16).replace("T", " ")}`
			: "missing",
		existsSync(plugin) ? undefined : "npm run build",
	);
	// The extension matters: an installed .sdPlugin folder has no package.json,
	// so a `.js` file there would be read as CommonJS and fail to load.
	report(
		existsSync(bridge) ? OK : FAIL,
		"Claude bridge bundle",
		existsSync(bridge) ? "statusline.mjs" : "missing",
		existsSync(bridge) ? undefined : "npm run build",
	);
}

function streamDeckPluginsDir() {
	// Roaming, not Local: the Stream Deck app keeps plugins under %APPDATA%.
	const appData = process.env.APPDATA;
	if (IS_WINDOWS && appData) {
		return join(appData, "Elgato", "StreamDeck", "Plugins");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", "com.elgato.StreamDeck", "Plugins");
	}
	return undefined;
}

function checkStreamDeck() {
	section("Stream Deck");
	const dir = streamDeckPluginsDir();
	if (dir === undefined || !existsSync(dir)) {
		report(
			WARN,
			"Stream Deck app",
			dir === undefined ? "not applicable on this platform" : "plugin folder not found",
			"Install the Stream Deck app 6.5 or newer, then run it once.",
		);
		return;
	}
	report(OK, "Plugin folder", dir);

	const installed = readdirSync(dir).filter((name) => name.startsWith(PLUGIN_UUID));
	report(
		installed.length > 0 ? OK : WARN,
		"AgentDeck installed",
		installed.length > 0 ? installed.join(", ") : "not linked",
		installed.length > 0
			? undefined
			: `npx @elgato/cli link ${PLUGIN_UUID}.sdPlugin\nnpx @elgato/cli restart ${PLUGIN_UUID}`,
	);
}

async function checkCodex() {
	section("Codex");
	const version = await run("codex", ["--version"]);
	if (version.missing) {
		report(
			FAIL,
			"Codex CLI",
			"not on PATH",
			"Install the Codex CLI, or set an executable override in any\n" +
				"AgentDeck Property Inspector under Plugin settings.",
		);
		return;
	}
	report(version.ok ? OK : WARN, "Codex CLI", version.stdout.trim() || `exit ${version.code}`);

	// The handshake is the real test: a CLI that answers `--version` can still be
	// too old for `app-server`, which is the only interface AgentDeck uses.
	const handshake = await probeAppServer();
	report(
		handshake.ok ? OK : FAIL,
		"codex app-server --stdio",
		handshake.detail,
		handshake.ok ? undefined : "AgentDeck talks to Codex only through app-server. Update the Codex CLI.",
	);
	if (!handshake.ok) {
		return;
	}
	report(
		handshake.authenticated ? OK : WARN,
		"Codex sign-in",
		handshake.authenticated ? "signed in" : "not signed in",
		handshake.authenticated ? undefined : "Run `codex` once and sign in. The deck shows LOGIN until you do.",
	);
}

/** One real handshake, then `account/read`, then close. */
function probeAppServer() {
	return new Promise((resolve) => {
		const child = execFile("codex", ["app-server", "--stdio"], { windowsHide: true }, () => {});
		let buffer = "";
		let settled = false;

		const finish = (value) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			try {
				child.kill();
			} catch {
				/* already gone */
			}
			resolve(value);
		};

		const timer = setTimeout(
			() => finish({ ok: false, detail: "no response within 15s", authenticated: false }),
			15000,
		);

		child.on("error", () => finish({ ok: false, detail: "could not start", authenticated: false }));
		child.stdout?.on("data", (chunk) => {
			buffer += String(chunk);
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line.length === 0) {
					continue;
				}
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id === 1) {
					// Handshake accepted; `initialized` unlocks the rest of the API.
					child.stdin?.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
					child.stdin?.write(`${JSON.stringify({ id: 2, method: "account/read", params: {} })}\n`);
					continue;
				}
				if (message.id === 2) {
					const account = message.result ?? {};
					finish({
						ok: true,
						detail: "handshake ok",
						// The account union is tagged; anything but `unauthenticated` is signed in.
						authenticated: message.error === undefined && account.type !== undefined,
					});
				}
			}
		});

		child.stdin?.write(
			`${JSON.stringify({
				id: 1,
				method: "initialize",
				params: { clientInfo: { name: "agentdeck-doctor", version: "0.0.1" }, capabilities: {} },
			})}\n`,
		);
	});
}

async function checkGit() {
	section("Git");
	const version = await run("git", ["--version"]);
	report(
		version.missing ? WARN : OK,
		"git",
		version.missing ? "not on PATH" : version.stdout.trim(),
		version.missing ? "The Git and Diff keys will show NO GIT until git is installed." : undefined,
	);
}

async function checkDesktop() {
	section("Desktop capture");
	if (!IS_WINDOWS) {
		report(
			WARN,
			"Clipboard / screenshot / voice",
			"Windows only",
			"These keys report SETUP on this platform.",
		);
		return;
	}

	const shell = await run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"$PSVersionTable.PSVersion.Major",
	]);
	report(
		shell.ok ? OK : FAIL,
		"Windows PowerShell",
		shell.ok ? `v${shell.stdout.trim()}` : "not available",
		shell.ok ? undefined : "Clipboard, screenshot and push-to-talk all go through powershell.exe.",
	);
	if (!shell.ok) {
		return;
	}

	const speech = await run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"try { Add-Type -AssemblyName System.Speech; 'yes' } catch { 'no' }",
	]);
	const hasSpeech = speech.stdout.includes("yes");
	report(
		hasSpeech ? OK : WARN,
		"System.Speech",
		hasSpeech ? "available" : "not available",
		hasSpeech ? undefined : "Push-to-Talk needs it. Everything else is unaffected.",
	);

	const mic = await run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"try { Add-Type -AssemblyName System.Speech; " +
			"$e = New-Object System.Speech.Recognition.SpeechRecognitionEngine; " +
			"$e.SetInputToDefaultAudioDevice(); $e.Dispose(); 'yes' } catch { 'no' }",
	]);
	const hasMic = mic.stdout.includes("yes");
	report(
		hasMic ? OK : WARN,
		"Microphone",
		hasMic ? "default input device opens" : "no usable input device",
		hasMic ? undefined : "Push-to-Talk will report a failure rather than silence.",
	);
}

function agentDeckDataDir() {
	if (IS_WINDOWS && process.env.LOCALAPPDATA) {
		return join(process.env.LOCALAPPDATA, "AgentDeck");
	}
	const home = homedir();
	return home.length > 0 ? join(home, ".agentdeck") : join(tmpdir(), "agentdeck");
}

function checkClaudeBridge() {
	section("Claude bridge");
	const dir = agentDeckDataDir();
	const files = existsSync(dir)
		? readdirSync(dir).filter((name) => name.startsWith("claude-status") && name.endsWith(".json"))
		: [];

	if (files.length === 0) {
		report(
			WARN,
			"Bridge readings",
			`none in ${dir}`,
			"Claude usage stays at SETUP until Claude Code's status line points here.\n" +
				"See “Connecting Claude” in the README. Codex is unaffected.",
		);
		return;
	}

	const newest = files
		.map((name) => ({ name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
		.sort((left, right) => right.mtime - left.mtime)[0];
	const ageMinutes = Math.round((Date.now() - newest.mtime) / 60000);

	let parsed;
	try {
		const payload = JSON.parse(readFileSync(newest.path, "utf8"));
		parsed = typeof payload === "object" && payload !== null;
	} catch {
		parsed = false;
	}

	report(
		parsed ? OK : FAIL,
		"Bridge readings",
		`${files.length} file(s), newest ${ageMinutes} min old`,
		parsed ? undefined : `${newest.path} is not readable JSON. Delete it and run Claude Code again.`,
	);
	if (parsed && ageMinutes > 30) {
		report(
			WARN,
			"Bridge freshness",
			`${ageMinutes} minutes old`,
			"The deck will show STALE. That is correct if Claude Code is not running.",
		);
	}
}

// ------------------------------------------------------------------------ main

console.log("AgentDeck preflight\n===================");

checkPlatform();
checkNode();
checkBuild();
checkStreamDeck();
await checkCodex();
await checkGit();
await checkDesktop();
checkClaudeBridge();

const failed = results.filter((entry) => entry.status === FAIL);
const warned = results.filter((entry) => entry.status === WARN);

section("Summary");
console.log(
	`${results.length - failed.length - warned.length} ok, ${warned.length} warning(s), ${failed.length} failure(s)`,
);
if (failed.length > 0) {
	console.log("\nFix the failures above before testing on the device.");
} else if (warned.length > 0) {
	console.log("\nNothing is broken. Each warning names what it disables.");
} else {
	console.log("\nReady. Work through docs/DEVICE_TEST.md.");
}

// A failure is a real blocker; a warning is a feature the user may not want.
process.exit(failed.length > 0 ? 1 : 0);
