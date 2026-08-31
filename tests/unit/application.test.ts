/**
 * Design §17.1 / §17.2 (shared cache, single-flight, stale retention) and §9
 * of the instructions (actions never hold provider state).
 */
import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry } from "@/application/provider-registry.js";
import { SessionService } from "@/application/session-service.js";
import { UsageService } from "@/application/usage-service.js";
import { AgentDeckError } from "@/domain/errors.js";
import type { ProviderEvent, ProviderEventListener } from "@/domain/provider-events.js";
import type { AgentSession } from "@/domain/session.js";
import type { UsageSnapshot } from "@/domain/usage.js";
import type { AgentProvider } from "@/providers/provider.js";
import { Backoff, Throttle } from "@/infrastructure/backoff.js";
import { SingleFlight } from "@/infrastructure/single-flight.js";
import { resolveExecutable } from "@/infrastructure/executable.js";
import { ControllableProvider } from "../helpers/fake-runtime.js";

class FakeProvider implements AgentProvider {
	public readonly displayName: string;
	public refreshCalls = 0;
	public interrupted: string[] = [];
	public failWith: unknown;
	public sessions: AgentSession[] = [];
	readonly #listeners = new Set<ProviderEventListener>();

	public constructor(
		public readonly id: string,
		public windows: UsageSnapshot["windows"] = [{ id: "w", label: "5h", usedPercent: 10 }],
	) {
		this.displayName = id.toUpperCase();
	}

	public async isAvailable(): Promise<boolean> {
		return true;
	}
	public async start(): Promise<void> {}
	public async stop(): Promise<void> {}

	public async refreshUsage(): Promise<UsageSnapshot> {
		this.refreshCalls += 1;
		await new Promise((resolve) => setTimeout(resolve, 5));
		if (this.failWith !== undefined) {
			throw this.failWith;
		}
		return { providerId: this.id, status: "ready", fetchedAt: new Date(), windows: this.windows };
	}

	public async listSessions(): Promise<AgentSession[]> {
		return this.sessions;
	}

	public async interrupt(sessionId: string): Promise<void> {
		this.interrupted.push(sessionId);
	}

	public subscribe(listener: ProviderEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	public emit(event: ProviderEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}
}

describe("provider registry (design §8.1, §27)", () => {
	it("keeps one failing provider from stopping the others", async () => {
		const registry = new ProviderRegistry();
		const healthy = new FakeProvider("codex");
		const broken = new FakeProvider("broken");
		broken.start = () => Promise.reject(new AgentDeckError("CLI_NOT_FOUND", "missing"));
		registry.register(healthy);
		registry.register(broken);

		const results = await registry.startAll();
		expect(results.find((r) => r.providerId === "codex")?.started).toBe(true);
		expect(results.find((r) => r.providerId === "broken")?.started).toBe(false);
	});

	it("refuses duplicate registrations", () => {
		const registry = new ProviderRegistry();
		registry.register(new FakeProvider("codex"));
		expect(() => registry.register(new FakeProvider("codex"))).toThrow(/already registered/);
	});

	it("fans provider events out to subscribers", () => {
		const registry = new ProviderRegistry();
		const provider = new FakeProvider("codex");
		registry.register(provider);

		const seen: ProviderEvent[] = [];
		registry.subscribe((event) => seen.push(event));
		provider.emit({ type: "provider-status", providerId: "codex", status: "ready" });
		expect(seen).toHaveLength(1);
	});

	it("survives a listener that throws", () => {
		const registry = new ProviderRegistry();
		const provider = new FakeProvider("codex");
		registry.register(provider);
		registry.subscribe(() => {
			throw new Error("bad listener");
		});
		const seen: ProviderEvent[] = [];
		registry.subscribe((event) => seen.push(event));

		expect(() =>
			provider.emit({ type: "provider-status", providerId: "codex", status: "ready" }),
		).not.toThrow();
		expect(seen).toHaveLength(1);
	});
});

describe("usage service (design §17)", () => {
	const setup = (): { registry: ProviderRegistry; provider: FakeProvider; usage: UsageService } => {
		const registry = new ProviderRegistry();
		const provider = new FakeProvider("codex");
		registry.register(provider);
		return { registry, provider, usage: new UsageService(registry, { manualRefreshThrottleMs: 0 }) };
	};

	it("collapses concurrent refreshes into one provider call", async () => {
		const { provider, usage } = setup();
		await Promise.all([usage.refresh("codex"), usage.refresh("codex"), usage.refresh("codex")]);
		expect(provider.refreshCalls).toBe(1);
	});

	it("serves later readers from the shared cache", async () => {
		const { usage } = setup();
		await usage.refresh("codex");
		expect(usage.getSnapshot("codex")?.windows).toHaveLength(1);
	});

	it("stores snapshots pushed by the provider without being asked", () => {
		const { provider, usage } = setup();
		const seen: UsageSnapshot[] = [];
		usage.subscribe((snapshot) => seen.push(snapshot));

		provider.emit({
			type: "usage-updated",
			snapshot: { providerId: "codex", status: "ready", fetchedAt: new Date(), windows: [] },
		});
		expect(seen).toHaveLength(1);
		expect(usage.getSnapshot("codex")).toBeDefined();
	});

	it("degrades to STALE, keeping the last good windows", async () => {
		const { provider, usage } = setup();
		await usage.refresh("codex");
		provider.failWith = new AgentDeckError("PROVIDER_OFFLINE", "gone");

		const snapshot = await usage.refresh("codex");
		expect(snapshot.status).toBe("stale");
		expect(snapshot.windows).toHaveLength(1);
		expect(snapshot.error?.code).toBe("PROVIDER_OFFLINE");
	});

	it("degrades to ERROR when there is nothing cached", async () => {
		const { provider, usage } = setup();
		provider.failWith = new AgentDeckError("PROVIDER_OFFLINE", "gone");
		expect((await usage.refresh("codex")).status).toBe("error");
	});

	it("reports LOGIN_REQUIRED distinctly from a generic failure", async () => {
		const { provider, usage } = setup();
		provider.failWith = new AgentDeckError("NOT_AUTHENTICATED", "sign in");
		expect((await usage.refresh("codex")).status).toBe("login-required");
	});

	it("throttles a mashed manual refresh but still returns the cache", async () => {
		const registry = new ProviderRegistry();
		const provider = new FakeProvider("codex");
		registry.register(provider);
		const usage = new UsageService(registry, { manualRefreshThrottleMs: 10_000 });

		await usage.refresh("codex", { manual: true });
		const second = await usage.refresh("codex", { manual: true });
		expect(provider.refreshCalls).toBe(1);
		expect(second.windows).toHaveLength(1);
	});

	it("lists providers side by side without summing them (design §18)", async () => {
		const registry = new ProviderRegistry();
		registry.register(new FakeProvider("codex", [{ id: "a", label: "5h", usedPercent: 41 }]));
		registry.register(new FakeProvider("claude", [{ id: "b", label: "7d", usedPercent: 96 }]));
		const usage = new UsageService(registry);
		await usage.refreshAll();

		const overview = usage.overview();
		expect(overview.map((row) => [row.providerId, row.window?.usedPercent])).toEqual([
			["codex", 41],
			["claude", 96],
		]);
	});
});

describe("session service (design §12.2, instructions §9)", () => {
	const session = (id: string, state: AgentSession["state"]): AgentSession => ({
		id,
		providerId: "codex",
		state,
		updatedAt: new Date(),
	});

	it("tracks sessions pushed by the provider and picks the active one", () => {
		const registry = new ProviderRegistry();
		const provider = new FakeProvider("codex");
		registry.register(provider);
		const sessions = new SessionService(registry);

		provider.emit({ type: "session-updated", session: session("thr_1", "idle") });
		provider.emit({ type: "session-updated", session: session("thr_2", "working") });
		expect(sessions.getActiveSession()?.id).toBe("thr_2");
	});

	it("honours a pin and falls back when the pinned session disappears", () => {
		const registry = new ProviderRegistry();
		const provider = new FakeProvider("codex");
		registry.register(provider);
		const sessions = new SessionService(registry);

		provider.emit({ type: "session-updated", session: session("thr_1", "idle") });
		provider.emit({ type: "session-updated", session: session("thr_2", "working") });
		sessions.pin("thr_1");
		expect(sessions.getActiveSession()?.id).toBe("thr_1");

		provider.emit({ type: "session-removed", sessionId: "thr_1" });
		expect(sessions.getActiveSession()?.id).toBe("thr_2");
	});

	it("interrupts the active session through its own provider", async () => {
		const registry = new ProviderRegistry();
		const provider = new FakeProvider("codex");
		registry.register(provider);
		const sessions = new SessionService(registry);

		provider.emit({ type: "session-updated", session: session("thr_1", "working") });
		await sessions.interruptActive();
		expect(provider.interrupted).toEqual(["thr_1"]);
	});

	it("refuses to interrupt when nothing is running", async () => {
		const registry = new ProviderRegistry();
		const provider = new FakeProvider("codex");
		registry.register(provider);
		const sessions = new SessionService(registry);

		provider.emit({ type: "session-updated", session: session("thr_1", "idle") });
		await expect(sessions.interruptActive()).rejects.toMatchObject({ code: "INTERRUPTED" });
	});

	it("keeps ids from different providers apart", async () => {
		const registry = new ProviderRegistry();
		const codex = new FakeProvider("codex");
		const other = new FakeProvider("other");
		registry.register(codex);
		registry.register(other);
		const sessions = new SessionService(registry);

		codex.emit({ type: "session-updated", session: session("shared-id", "working") });
		other.emit({
			type: "session-updated",
			session: { ...session("shared-id", "idle"), providerId: "other" },
		});
		expect(sessions.list()).toHaveLength(2);
		expect(sessions.list("codex")).toHaveLength(1);
	});
});

describe("infrastructure primitives", () => {
	it("coalesces work per key and releases the slot afterwards", async () => {
		const flight = new SingleFlight();
		const task = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return 1;
		});
		await Promise.all([flight.run("a", task), flight.run("a", task), flight.run("b", task)]);
		expect(task).toHaveBeenCalledTimes(2);
		expect(flight.size).toBe(0);
	});

	it("releases the slot when the task rejects", async () => {
		const flight = new SingleFlight();
		await expect(flight.run("a", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
		expect(flight.isRunning("a")).toBe(false);
	});

	it("grows the backoff delay and caps it", () => {
		const backoff = new Backoff({
			initialDelayMs: 100,
			maxDelayMs: 500,
			factor: 2,
			jitter: 0,
			random: () => 0.5,
		});
		expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([100, 200, 400, 500]);
		backoff.reset();
		expect(backoff.next()).toBe(100);
	});

	it("applies jitter within the configured band", () => {
		const backoff = new Backoff({ initialDelayMs: 1000, jitter: 0.2, random: () => 1 });
		expect(backoff.next()).toBe(1200);
	});

	it("throttles repeated user presses", () => {
		let now = 0;
		const throttle = new Throttle(1000, () => now);
		expect(throttle.tryAcquire()).toBe(true);
		expect(throttle.tryAcquire()).toBe(false);
		now = 1001;
		expect(throttle.tryAcquire()).toBe(true);
	});

	it("resolves an executable on PATH and reports a missing one", () => {
		expect(resolveExecutable(process.execPath)).toBe(process.execPath);
		expect(resolveExecutable("definitely-not-a-real-binary-xyz")).toBeUndefined();
	});
});

describe("session highlight (design §6.1 dial 2)", () => {
	function setup() {
		const registry = new ProviderRegistry();
		const provider = new ControllableProvider();
		registry.register(provider);
		const sessions = new SessionService(registry);
		const push = (id: string, state: AgentSession["state"], updatedAt: number): void => {
			provider.pushSession({ id, providerId: "codex", state, updatedAt: new Date(updatedAt) });
		};
		return { sessions, provider, push };
	}

	it("starts from the active session rather than the top of the list", () => {
		const { sessions, push } = setup();
		push("thr_b", "idle", 1);
		push("thr_a", "working", 2);

		// `thr_a` is busiest, so that is what the deck is already showing.
		expect(sessions.getHighlighted("codex")?.id).toBe("thr_a");
	});

	it("rotates in a stable order and wraps both ways", () => {
		const { sessions, push } = setup();
		push("thr_a", "idle", 1);
		push("thr_b", "idle", 2);
		push("thr_c", "idle", 3);

		const seen: (string | undefined)[] = [];
		for (let step = 0; step < 4; step += 1) {
			sessions.rotateHighlight("codex", 1);
			seen.push(sessions.getHighlighted("codex")?.id);
		}
		// Four steps through three sessions must come back to where it started.
		expect(seen[0]).toBe(seen[3]);

		const before = sessions.getHighlighted("codex")?.id;
		sessions.rotateHighlight("codex", -1);
		sessions.rotateHighlight("codex", 1);
		expect(sessions.getHighlighted("codex")?.id).toBe(before);
	});

	it("rotating alone does not change the active session", () => {
		const { sessions, push } = setup();
		push("thr_a", "working", 2);
		push("thr_b", "idle", 1);

		sessions.rotateHighlight("codex", 1);

		expect(sessions.pinnedSessionId).toBeUndefined();
		expect(sessions.getActiveSession("codex")?.id).toBe("thr_a");
	});

	it("pinning the highlighted session makes it the active one", () => {
		const { sessions, push } = setup();
		push("thr_a", "working", 2);
		push("thr_b", "idle", 1);
		sessions.rotateHighlight("codex", 1);

		const pinned = sessions.pinHighlighted("codex");

		expect(pinned?.id).toBe("thr_b");
		expect(sessions.getActiveSession("codex")?.id).toBe("thr_b");
	});

	it("pinning the already pinned session releases it", () => {
		const { sessions, push } = setup();
		push("thr_a", "working", 2);
		push("thr_b", "idle", 1);
		sessions.rotateHighlight("codex", 1);
		sessions.pinHighlighted("codex");

		sessions.pinHighlighted("codex");

		expect(sessions.pinnedSessionId).toBeUndefined();
		expect(sessions.getActiveSession("codex")?.id).toBe("thr_a");
	});

	it("forgets a highlight whose session went away", () => {
		const { sessions, provider, push } = setup();
		push("thr_a", "working", 2);
		push("thr_b", "idle", 1);
		sessions.rotateHighlight("codex", 1);
		expect(sessions.getHighlighted("codex")?.id).toBe("thr_b");

		provider.emit({ type: "session-removed", sessionId: "thr_b" });

		expect(sessions.getHighlighted("codex")?.id).toBe("thr_a");
	});

	it("does nothing when there is no session to rotate through", () => {
		const { sessions } = setup();

		sessions.rotateHighlight("codex", 1);

		expect(sessions.getHighlighted("codex")).toBeUndefined();
		expect(sessions.pinHighlighted("codex")).toBeUndefined();
	});
});
