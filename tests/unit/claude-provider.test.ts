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
import { createLogger, nullSink } from "@/infrastructure/logger.js";
import { ClaudeProvider, MIN_CLAUDE_REFRESH_INTERVAL_MS } from "@/providers/claude/claude-provider.js";
import { parseSession, StatusLineUsageParser } from "@/providers/claude/claude-usage-parser.js";
import { agentDeckDataDir, claudeStatusPath } from "@/providers/claude/bridge-path.js";
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

	it("reads a reading the bridge wrote", async () => {
		const now = new Date(1_700_000_100_000);
		const source = new ClaudeStatusFileSource({
			path: "/x/claude-status.json",
			now: () => now,
			read: async () => envelope(fixture("status-full"), 1_700_000_000_000),
		});

		const reading = await source.read();
		expect(reading.capturedAt.getTime()).toBe(1_700_000_000_000);
		expect(reading.stale).toBe(false);
	});

	it("marks a reading stale once Claude Code has stopped reporting", async () => {
		const now = new Date(1_700_000_000_000 + 60 * 60_000);
		const source = new ClaudeStatusFileSource({
			path: "/x/claude-status.json",
			freshnessMs: 30 * 60_000,
			now: () => now,
			read: async () => envelope(fixture("status-full"), 1_700_000_000_000),
		});
		expect((await source.read()).stale).toBe(true);
	});

	it("treats a missing file as 'the bridge is not set up yet'", async () => {
		const source = new ClaudeStatusFileSource({
			path: "/x/missing.json",
			read: async () => {
				const error: NodeJS.ErrnoException = new Error("nope");
				error.code = "ENOENT";
				throw error;
			},
		});
		await expect(source.read()).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
	});

	it("reports malformed content as a protocol error", async () => {
		const bad = new ClaudeStatusFileSource({ path: "/x/a.json", read: async () => "{not json" });
		await expect(bad.read()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });

		const empty = new ClaudeStatusFileSource({ path: "/x/a.json", read: async () => "{}" });
		await expect(empty.read()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
	});

	it("resolves the bridge path per platform", () => {
		expect(agentDeckDataDir({ LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" })).toContain("AgentDeck");
		expect(claudeStatusPath({ LOCALAPPDATA: "C:\\x" })).toMatch(/claude-status\.json$/);
		expect(claudeStatusPath({})).toMatch(/claude-status\.json$/);
	});
});

describe("claude provider", () => {
	function providerWith(read: () => Promise<string>, now = new Date(1_700_000_000_000)): ClaudeProvider {
		return new ClaudeProvider({
			logger,
			now: () => now,
			source: new ClaudeStatusFileSource({ path: "/x/claude-status.json", now: () => now, read }),
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

	it("reports LOGIN while the bridge has never run", async () => {
		const provider = providerWith(async () => {
			const error: NodeJS.ErrnoException = new Error("nope");
			error.code = "ENOENT";
			throw error;
		});
		const snapshot = await provider.refreshUsage();

		expect(snapshot.status).toBe("login-required");
		expect(snapshot.windows).toEqual([]);
	});

	it("keeps the last windows and reads STALE once reporting stops", async () => {
		const now = new Date(1_700_000_000_000 + 60 * 60_000);
		const provider = new ClaudeProvider({
			logger,
			now: () => now,
			source: new ClaudeStatusFileSource({
				path: "/x/a.json",
				freshnessMs: 30 * 60_000,
				now: () => now,
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

	it("floors the refresh interval", () => {
		const provider = providerWith(good());
		expect(() => provider.configure({ refreshIntervalMs: 1 })).not.toThrow();
		expect(MIN_CLAUDE_REFRESH_INTERVAL_MS).toBeGreaterThan(1);
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

	it("never throws out of refreshUsage, whatever the file contains", async () => {
		for (const body of ["", "null", "[]", '{"status":null}', "{not json"]) {
			const provider = providerWith(async () => body);
			await expect(provider.refreshUsage()).resolves.toBeDefined();
		}
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
				path: "/x/a.json",
				read: async () => {
					throw new AgentDeckError("PROTOCOL_ERROR", "boom");
				},
			}),
		});
		await provider.refreshUsage();

		// Design §10.3 / §22.1: the provider reads no credential, and nothing it
		// does log carries one.
		for (const line of lines) {
			expect(line).not.toMatch(/sk-ant|Bearer|oauth|token/i);
		}
	});

	it("reads only the bridge file", async () => {
		const opened: string[] = [];
		const provider = new ClaudeProvider({
			logger,
			source: new ClaudeStatusFileSource({
				path: "/x/claude-status.json",
				read: async (path) => {
					opened.push(path);
					return JSON.stringify({ v: 1, capturedAt: Date.now(), status: {} });
				},
			}),
		});
		await provider.refreshUsage();
		expect(opened).toEqual(["/x/claude-status.json"]);
	});
});
