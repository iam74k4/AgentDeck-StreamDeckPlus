/**
 * Design §10.2 — the Claude usage parser is fixture-backed on purpose: the
 * status-line schema is the surface most likely to move underneath us, and a
 * schema change must degrade the display rather than break the plugin.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentDeckError } from "@/domain/errors.js";
import type { AgentProvider } from "@/providers/provider.js";
import { buildAgentStatusViewModel } from "@/presentation/view-models/agent-status.js";
import { createLogger, nullSink } from "@/infrastructure/logger.js";
import { ClaudeProvider, MIN_CLAUDE_REFRESH_INTERVAL_MS } from "@/providers/claude/claude-provider.js";
import { parseSession, StatusLineUsageParser } from "@/providers/claude/claude-usage-parser.js";
import { agentDeckDataDir, claudeStatusFilename } from "@/providers/claude/bridge-path.js";
import { ClaudeStatusFileSource } from "@/providers/claude/status-file-source.js";
import { CLAUDE_BRIDGE_FORMAT } from "@/providers/claude/status-payload.js";
import { buildOverviewViewModel } from "@/presentation/view-models/overview.js";

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(fileURLToPath(new URL(`../fixtures/claude/${name}.json`, import.meta.url)), "utf8"),
	);

const logger = createLogger({ sink: nullSink });

describe("status-line usage parser", () => {
	const parser = new StatusLineUsageParser();

	it("maps the documented payload onto domain windows", () => {
		const windows = parser.parse(fixture("status-full"));

		expect(windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
			["claude.five_hour", "5h", 23.5],
			["claude.seven_day", "7d", 41.2],
			["claude.spend_limit", "Spend", 62.8],
		]);
		expect(windows[0]?.windowDurationMinutes).toBe(300);
		expect(windows[1]?.windowDurationMinutes).toBe(10_080);
		// A spend limit has no fixed period.
		expect(windows[2]?.windowDurationMinutes).toBeUndefined();
		expect(windows[0]?.resetsAt?.getTime()).toBe(1738425600 * 1000);
	});

	it("keeps working when only some windows are reported", () => {
		const windows = parser.parse(fixture("status-minimal"));
		expect(windows.map((w) => w.id)).toEqual(["claude.five_hour", "claude.seven_day"]);
		expect(windows[0]?.resetsAt).toBeUndefined();
	});

	it("returns nothing rather than throwing when rate limits are absent", () => {
		expect(parser.parse(fixture("status-no-limits"))).toEqual([]);
	});

	it("survives every shape a schema change could produce", () => {
		for (const raw of [null, undefined, 42, "text", [], {}, { rate_limits: null }, { rate_limits: 7 }]) {
			expect(() => parser.parse(raw)).not.toThrow();
			expect(parser.parse(raw)).toEqual([]);
		}
	});

	it("ignores a window whose percentage is not a usable number", () => {
		const windows = parser.parse({
			rate_limits: {
				five_hour: { used_percentage: "23.5" },
				seven_day: { used_percentage: Number.NaN },
				spend_limit: { used_percentage: 10 },
			},
		});
		expect(windows.map((w) => w.id)).toEqual(["claude.spend_limit"]);
	});

	it("keeps a spend limit above 100 rather than clamping the model", () => {
		const windows = parser.parse({ rate_limits: { spend_limit: { used_percentage: 137 } } });
		expect(windows[0]?.usedPercent).toBe(137);
	});
});

describe("session mapping", () => {
	const now = new Date(1_700_000_000_000);

	it("reports the open session as idle, never as working", () => {
		const session = parseSession(fixture("status-full"), "claude", now);
		// Claude Code's status line says a session exists; it never says a turn is
		// running, so the deck must not claim one is.
		expect(session).toMatchObject({
			id: "abc123-session",
			providerId: "claude",
			state: "idle",
			modelId: "claude-opus-5",
			label: "my-session",
		});
	});

	it("falls back to the model display name when the session is unnamed", () => {
		expect(parseSession(fixture("status-minimal"), "claude", now)?.label).toBe("Sonnet");
	});

	it("returns nothing without a session id", () => {
		expect(parseSession({ model: { id: "x" } }, "claude", now)).toBeUndefined();
		expect(parseSession(null, "claude", now)).toBeUndefined();
	});
});

describe("bridge file source", () => {
	const envelope = (payload: unknown, capturedAt: number): string =>
		JSON.stringify({ v: CLAUDE_BRIDGE_FORMAT, capturedAt, status: payload });

	const source = (options: {
		files: Record<string, string>;
		now?: Date;
		freshnessMs?: number;
		retentionMs?: number;
		removed?: string[];
	}): ClaudeStatusFileSource =>
		new ClaudeStatusFileSource({
			dir: "/x",
			...(options.now === undefined ? {} : { now: () => options.now as Date }),
			...(options.freshnessMs === undefined ? {} : { freshnessMs: options.freshnessMs }),
			...(options.retentionMs === undefined ? {} : { retentionMs: options.retentionMs }),
			list: async () => Object.keys(options.files),
			read: async (path) => {
				const body = options.files[path.replace(/^\/x[/\\]/, "")];
				if (body === undefined) {
					throw new Error(`unexpected read: ${path}`);
				}
				return body;
			},
			remove: async (path) => {
				options.removed?.push(path);
			},
		});

	it("reads a reading the bridge wrote", async () => {
		const reading = await source({
			files: { "claude-status.a.json": envelope(fixture("status-full"), 1_700_000_000_000) },
			now: new Date(1_700_000_100_000),
		}).read();

		expect(reading.capturedAt.getTime()).toBe(1_700_000_000_000);
		expect(reading.stale).toBe(false);
	});

	it("picks the most recent session when several are open", async () => {
		const reading = await source({
			files: {
				"claude-status.older.json": envelope({ session_id: "older" }, 1_700_000_000_000),
				"claude-status.newer.json": envelope({ session_id: "newer" }, 1_700_000_050_000),
			},
			now: new Date(1_700_000_060_000),
		}).read();

		// Two terminals no longer overwrite each other; the deck follows whichever
		// session produced a message last.
		expect(reading.payload.session_id).toBe("newer");
	});

	it("skips an unreadable reading rather than failing the whole scan", async () => {
		const reading = await source({
			files: {
				"claude-status.broken.json": "{not json",
				"claude-status.good.json": envelope({ session_id: "good" }, 1_700_000_000_000),
			},
			now: new Date(1_700_000_000_000),
		}).read();
		expect(reading.payload.session_id).toBe("good");
	});

	it("deletes readings past the retention window", async () => {
		const removed: string[] = [];
		const store = source({
			files: {
				"claude-status.ancient.json": envelope({ session_id: "ancient" }, 1_000_000_000_000),
				"claude-status.fresh.json": envelope({ session_id: "fresh" }, 1_700_000_000_000),
			},
			now: new Date(1_700_000_000_000),
			removed,
		});

		expect((await store.read()).payload.session_id).toBe("fresh");
		await new Promise((resolve) => setImmediate(resolve));
		expect(removed.join()).toContain("ancient");
	});

	it("marks a reading stale once Claude Code has stopped reporting", async () => {
		const reading = await source({
			files: { "claude-status.a.json": envelope(fixture("status-full"), 1_700_000_000_000) },
			now: new Date(1_700_000_000_000 + 60 * 60_000),
			freshnessMs: 30 * 60_000,
		}).read();
		expect(reading.stale).toBe(true);
	});

	it("says the bridge is not configured, not that the user must sign in", async () => {
		const empty = new ClaudeStatusFileSource({ dir: "/x", list: async () => [] });
		await expect(empty.read()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });

		// A directory that does not exist is the same situation.
		const missing = new ClaudeStatusFileSource({
			dir: "/x",
			list: async () => {
				throw new Error("ENOENT");
			},
		});
		await expect(missing.read()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
	});

	it("reports malformed content as a protocol error", async () => {
		await expect(source({ files: { "claude-status.a.json": "{not json" } }).read()).rejects.toMatchObject({
			code: "PROTOCOL_ERROR",
		});
		await expect(source({ files: { "claude-status.a.json": "{}" } }).read()).rejects.toMatchObject({
			code: "PROTOCOL_ERROR",
		});
	});

	it("reports availability through the same seam it reads through", async () => {
		const listed: string[] = [];
		const store = new ClaudeStatusFileSource({
			dir: "/x",
			list: async (dir) => {
				listed.push(dir);
				return ["claude-status.a.json", "unrelated.txt"];
			},
		});

		await expect(store.isConfigured()).resolves.toBe(true);
		// No filesystem access outside the injected seam.
		expect(listed).toEqual(["/x"]);
	});

	it("ignores files that are not bridge readings", async () => {
		const store = new ClaudeStatusFileSource({ dir: "/x", list: async () => ["notes.txt", "README.md"] });
		await expect(store.isConfigured()).resolves.toBe(false);
	});

	it("keeps a session id from escaping the bridge directory", () => {
		expect(claudeStatusFilename("../../etc/passwd")).toBe("claude-status.....etcpasswd.json");
		expect(claudeStatusFilename(undefined)).toBe("claude-status.json");
		expect(claudeStatusFilename("!!!")).toBe("claude-status.json");
	});

	it("uses LOCALAPPDATA on Windows only", () => {
		const env = { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" };
		expect(agentDeckDataDir(env, "win32")).toContain("AgentDeck");
		// A stray export on macOS/Linux must not send the bridge somewhere the
		// GUI-launched Stream Deck app would never look.
		expect(agentDeckDataDir(env, "linux")).not.toContain("AppData");
		expect(agentDeckDataDir(env, "darwin")).toMatch(/\.agentdeck$/);
	});
});

describe("claude provider", () => {
	function providerWith(read: () => Promise<string>, now = new Date(1_700_000_000_000)): ClaudeProvider {
		return new ClaudeProvider({
			logger,
			now: () => now,
			source: new ClaudeStatusFileSource({
				dir: "/x",
				now: () => now,
				list: async () => ["claude-status.a.json"],
				read,
			}),
		});
	}

	const good = (payload: unknown = fixture("status-full")): (() => Promise<string>) => {
		return async () =>
			JSON.stringify({ v: CLAUDE_BRIDGE_FORMAT, capturedAt: 1_700_000_000_000, status: payload });
	};

	it("offers no interrupt, so the deck cannot promise a STOP it can't honour", () => {
		// Checked through the port, where `interrupt` and `steer` are the optional
		// members a monitoring-only provider is meant to decline (design §8.1).
		const provider: AgentProvider = providerWith(good());
		expect(provider.interrupt).toBeUndefined();
		expect(provider.steer).toBeUndefined();
		expect(typeof provider.refreshUsage).toBe("function");
		expect(typeof provider.listSessions).toBe("function");
	});

	it("publishes usage and a session after a refresh", async () => {
		const provider = providerWith(good());
		const snapshot = await provider.refreshUsage();

		expect(snapshot.providerId).toBe("claude");
		expect(snapshot.status).toBe("ready");
		expect(snapshot.windows).toHaveLength(3);
		await expect(provider.listSessions()).resolves.toHaveLength(1);
	});

	it("tells the user to set up the bridge rather than to sign in", async () => {
		const provider = new ClaudeProvider({
			logger,
			source: new ClaudeStatusFileSource({ dir: "/x", list: async () => [] }),
		});
		await expect(provider.refreshUsage()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });

		const snapshot = provider.usageSnapshot();
		expect(snapshot.error?.code).toBe("NOT_CONFIGURED");
		expect(snapshot.windows).toEqual([]);

		// The key says SETUP, not LOGIN: re-authenticating would change nothing.
		const vm = buildAgentStatusViewModel({
			providerLabel: "Claude",
			providerStatus: snapshot.status,
			errorCode: snapshot.error?.code,
		});
		expect(vm.stateLabel).toBe("SETUP");
		expect(vm.detail).toBe("setup needed");
	});

	it("still says LOGIN for a genuine sign-in failure", () => {
		const vm = buildAgentStatusViewModel({
			providerLabel: "Codex",
			providerStatus: "login-required",
			errorCode: "NOT_AUTHENTICATED",
		});
		expect(vm.stateLabel).toBe("LOGIN");
		expect(vm.detail).toBe("sign in");
	});

	it("keeps the last windows and reads STALE once reporting stops", async () => {
		const now = new Date(1_700_000_000_000 + 60 * 60_000);
		const provider = new ClaudeProvider({
			logger,
			now: () => now,
			source: new ClaudeStatusFileSource({
				dir: "/x",
				freshnessMs: 30 * 60_000,
				now: () => now,
				list: async () => ["claude-status.a.json"],
				read: good(),
			}),
		});

		const snapshot = await provider.refreshUsage();
		expect(snapshot.status).toBe("stale");
		expect(snapshot.windows).toHaveLength(3);
	});

	it("emits usage to subscribers without being polled", async () => {
		const provider = providerWith(good());
		const events: string[] = [];
		provider.subscribe((event) => events.push(event.type));

		await provider.refreshUsage();
		expect(events).toContain("usage-updated");
		expect(events).toContain("session-updated");
	});

	it("does not re-announce an unchanged session", async () => {
		const provider = providerWith(good());
		await provider.refreshUsage();

		const events: string[] = [];
		provider.subscribe((event) => events.push(event.type));
		await provider.refreshUsage();
		expect(events).not.toContain("session-updated");
	});

	it("floors the refresh interval instead of trusting the settings value", () => {
		const provider = providerWith(good());
		expect(provider.refreshIntervalMs).toBe(30_000);

		provider.configure({ refreshIntervalMs: 1 });
		expect(provider.refreshIntervalMs).toBe(MIN_CLAUDE_REFRESH_INTERVAL_MS);

		provider.configure({ refreshIntervalMs: 90_000 });
		expect(provider.refreshIntervalMs).toBe(90_000);
	});

	it("re-arms the timer on a settings change without flashing OFFLINE", async () => {
		const provider = providerWith(good());
		await provider.start();

		const events: string[] = [];
		provider.subscribe((event) => events.push(event.type));
		provider.configure({ refreshIntervalMs: 60_000 });

		// A Property Inspector edit arrives as several writes; tearing the provider
		// down for each would emit a disconnected session every time.
		expect(events).not.toContain("session-updated");
		expect(provider.refreshIntervalMs).toBe(60_000);
		await provider.stop();
	});

	it("re-emits a session whose label changed", async () => {
		let name = "api-work";
		const provider = new ClaudeProvider({
			logger,
			source: new ClaudeStatusFileSource({
				dir: "/x",
				list: async () => ["claude-status.a.json"],
				read: async () =>
					JSON.stringify({
						v: CLAUDE_BRIDGE_FORMAT,
						capturedAt: Date.now(),
						status: { session_id: "S1", session_name: name, model: { id: "claude-opus-5" } },
					}),
			}),
		});

		await provider.refreshUsage();
		const events: string[] = [];
		provider.subscribe((event) => events.push(event.type));

		name = "billing-fix";
		await provider.refreshUsage();
		expect(events).toContain("session-updated");
		expect((await provider.listSessions())[0]?.label).toBe("billing-fix");
	});

	it("marks its session disconnected on stop", async () => {
		const provider = providerWith(good());
		await provider.refreshUsage();

		const events: unknown[] = [];
		provider.subscribe((event) => events.push(event));
		await provider.stop();

		const sessions = await provider.listSessions();
		expect(sessions[0]?.state).toBe("disconnected");
	});

	it("reports a bad file as a rejection while still publishing the snapshot", async () => {
		for (const body of ["", "null", "[]", '{"status":null}', "{not json"]) {
			const provider = providerWith(async () => body);
			const events: string[] = [];
			provider.subscribe((event) => events.push(event.type));

			// The caller is told, so its error handling is real code rather than an
			// unreachable catch — and the deck still receives a degraded snapshot.
			await expect(provider.refreshUsage()).rejects.toBeDefined();
			expect(events).toContain("usage-updated");
		}
	});

	it("keeps polling after a failed read", async () => {
		let fail = true;
		const provider = new ClaudeProvider({
			logger,
			refreshIntervalMs: MIN_CLAUDE_REFRESH_INTERVAL_MS,
			source: new ClaudeStatusFileSource({
				dir: "/x",
				list: async () => ["claude-status.a.json"],
				read: async () => {
					if (fail) {
						throw new AgentDeckError("PROTOCOL_ERROR", "boom");
					}
					return JSON.stringify({ v: 1, capturedAt: Date.now(), status: fixture("status-full") });
				},
			}),
		});

		// start() must survive the initial failure rather than propagating it.
		await expect(provider.start()).resolves.toBeUndefined();
		expect(provider.usageSnapshot().status).toBe("error");

		fail = false;
		await provider.refreshUsage();
		expect(provider.usageSnapshot().status).toBe("ready");
		await provider.stop();
	});
});

describe("AI overview (design §18)", () => {
	const entry = (
		providerId: string,
		displayName: string,
		usedPercent?: number,
		label = "5h",
		status: "ready" | "stale" = "ready",
	) => ({
		providerId,
		displayName,
		status,
		...(usedPercent === undefined ? {} : { window: { id: `${providerId}.w`, label, usedPercent } }),
	});

	it("leads with the most constrained provider and never sums them", () => {
		const vm = buildOverviewViewModel([
			entry("codex", "Codex", 41, "5h"),
			entry("claude", "Claude", 96, "7d"),
		]);

		expect(vm.headline).toBe("CLAUDE 7d");
		expect(vm.valueText).toBe("96%");
		expect(vm.detail).toBe("Codex 41% 5h");
		// 41 + 96 must never appear anywhere.
		expect(vm.valueText).not.toContain("137");
	});

	it("keeps a provider that is reporting nothing visible", () => {
		const vm = buildOverviewViewModel([entry("codex", "Codex", 41), entry("claude", "Claude")]);
		expect(vm.headline).toBe("CODEX 5h");
		expect(vm.detail).toContain("Claude --");
	});

	it("flags a stale leader", () => {
		const vm = buildOverviewViewModel([entry("claude", "Claude", 96, "7d", "stale")]);
		expect(vm.detail).toContain("STALE");
	});

	it("flags a stale provider that is not the leader", () => {
		// A days-old reading behind a fresh one must not read as live.
		const vm = buildOverviewViewModel([
			entry("codex", "Codex", 96, "7d"),
			entry("claude", "Claude", 41, "5h", "stale"),
		]);

		expect(vm.headline).toBe("CODEX 7d");
		expect(vm.detail).toBe("Claude 41%! 5h");
	});

	it("leaves a fresh non-leader unmarked", () => {
		const vm = buildOverviewViewModel([
			entry("codex", "Codex", 96, "7d"),
			entry("claude", "Claude", 41, "5h"),
		]);
		expect(vm.detail).toBe("Claude 41% 5h");
	});

	it("degrades when nothing has reported yet", () => {
		expect(buildOverviewViewModel([]).valueText).toBe("--");
		const loading = buildOverviewViewModel([entry("codex", "Codex"), entry("claude", "Claude")]);
		expect(loading.valueText).toBe("…");
		expect(loading.detail).toBe("Codex · Claude");
	});
});

describe("no credential ever leaves the provider", () => {
	it("logs nothing from the payload beyond typed error codes", async () => {
		const lines: string[] = [];
		const capture = createLogger({
			sink: {
				error: (m) => lines.push(m),
				warn: (m) => lines.push(m),
				info: (m) => lines.push(m),
				debug: (m) => lines.push(m),
			},
			level: "debug",
		});

		const provider = new ClaudeProvider({
			logger: capture,
			source: new ClaudeStatusFileSource({
				dir: "/x",
				list: async () => ["claude-status.a.json"],
				read: async () => {
					throw new AgentDeckError("PROTOCOL_ERROR", "boom");
				},
			}),
		});
		await expect(provider.refreshUsage()).rejects.toBeDefined();

		// Design §10.3 / §22.1: the provider reads no credential, and nothing it
		// does log carries one.
		for (const line of lines) {
			expect(line).not.toMatch(/sk-ant|Bearer|oauth|token/i);
		}
	});

	it("reads only the bridge directory", async () => {
		const opened: string[] = [];
		const provider = new ClaudeProvider({
			logger,
			source: new ClaudeStatusFileSource({
				dir: "/x",
				list: async () => ["claude-status.a.json"],
				read: async (path) => {
					opened.push(path);
					return JSON.stringify({ v: 1, capturedAt: Date.now(), status: {} });
				},
			}),
		});
		await provider.refreshUsage();
		expect(opened.every((path) => path.includes("claude-status"))).toBe(true);
	});
});
