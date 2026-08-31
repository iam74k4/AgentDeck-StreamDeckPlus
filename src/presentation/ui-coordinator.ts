/**
 * UI update coordinator — design §20.2, instructions §9.
 *
 *   Provider Event → Session / Usage Store → UI Update Coordinator → affected actions only
 *
 * Actions subscribe to the concerns they actually draw, so a usage notification
 * does not repaint every key on the device.
 */

import type { GitService, GitStatusEntry } from "../application/git-service.js";
import type { ProviderRegistry } from "../application/provider-registry.js";
import type { SessionService } from "../application/session-service.js";
import type { UsageService } from "../application/usage-service.js";
import type { Unsubscribe } from "../domain/provider-events.js";
import type { ProviderId, UsageSnapshot, WindowSelection } from "../domain/usage.js";
import type { Logger } from "../infrastructure/logger.js";
import { scheduleInterval, type ScheduledTask } from "../infrastructure/scheduler.js";
import type { DashboardData } from "./plus-dashboard-coordinator.js";
import { buildAgentStatusViewModel } from "./view-models/agent-status.js";
import { buildGitViewModel } from "./view-models/git.js";
import { buildOverviewViewModel } from "./view-models/overview.js";
import { buildProviderViewModel } from "./view-models/provider.js";
import { buildUsageViewModel } from "./view-models/usage.js";

export type UiConcern = "usage" | "session" | "git" | "provider" | "tick";

export type UiListener = () => void;

export interface UiCoordinatorOptions {
	logger?: Logger;
	/** Cadence of the elapsed-time redraw while an agent is working (design §12.1). */
	tickIntervalMs?: number;
	now?: () => Date;
}

export class UiCoordinator {
	readonly #registry: ProviderRegistry;
	readonly #usage: UsageService;
	readonly #sessions: SessionService;
	readonly #git: GitService;
	readonly #logger: Logger | undefined;
	readonly #listeners = new Map<UiConcern, Set<UiListener>>();
	readonly #unsubscribes: Unsubscribe[] = [];
	readonly #tickIntervalMs: number;
	readonly #now: () => Date;
	#tick: ScheduledTask | undefined;

	public constructor(
		services: {
			registry: ProviderRegistry;
			usage: UsageService;
			sessions: SessionService;
			git: GitService;
		},
		options: UiCoordinatorOptions = {},
	) {
		this.#registry = services.registry;
		this.#usage = services.usage;
		this.#sessions = services.sessions;
		this.#git = services.git;
		this.#logger = options.logger?.child("ui");
		this.#tickIntervalMs = options.tickIntervalMs ?? 1_000;
		this.#now = options.now ?? (() => new Date());

		this.#unsubscribes.push(
			this.#usage.subscribe(() => this.invalidate("usage")),
			this.#sessions.subscribe(() => {
				this.invalidate("session");
				this.#syncTick();
			}),
			this.#git.subscribe(() => this.invalidate("git")),
			this.#registry.subscribe((event) => {
				if (event.type === "provider-status") {
					this.invalidate("provider");
				}
			}),
		);
	}

	public subscribe(concern: UiConcern, listener: UiListener): Unsubscribe {
		let set = this.#listeners.get(concern);
		if (set === undefined) {
			set = new Set();
			this.#listeners.set(concern, set);
		}
		set.add(listener);
		this.#syncTick();
		return () => {
			set.delete(listener);
			this.#syncTick();
		};
	}

	public invalidate(concern: UiConcern): void {
		for (const listener of this.#listeners.get(concern) ?? []) {
			try {
				listener();
			} catch (error) {
				this.#logger?.warn(`ui listener failed for ${concern}`, error);
			}
		}
	}

	public getUsageSnapshot(providerId: ProviderId): UsageSnapshot | undefined {
		return this.#usage.getSnapshot(providerId);
	}

	public getGitEntry(path: string): GitStatusEntry | undefined {
		return this.#git.get(path);
	}

	/** Builds the four segment view models for the touch strip. */
	public dashboardData(options: {
		providerId: ProviderId;
		repositoryPath?: string;
		/** Design §7.5 — a dial that pinned a window must keep showing that window. */
		windowSelection?: WindowSelection;
	}): DashboardData {
		const provider = this.#registry.get(options.providerId);
		const providerLabel = provider?.displayName ?? options.providerId;
		const snapshot = this.#usage.getSnapshot(options.providerId);
		const session = this.#sessions.getActiveSession(options.providerId);
		const now = this.#now();

		return {
			usage: buildUsageViewModel({
				providerLabel,
				snapshot,
				selection: options.windowSelection ?? { mode: "auto" },
				showResetAt: true,
				now,
			}),
			agent: buildAgentStatusViewModel({
				providerLabel,
				providerStatus: snapshot?.status ?? "loading",
				...(snapshot?.error === undefined ? {} : { errorCode: snapshot.error.code }),
				session,
				now,
			}),
			overview: buildOverviewViewModel(this.#usage.overview()),
			git: buildGitViewModel(
				options.repositoryPath === undefined ? undefined : this.#git.get(options.repositoryPath),
			),
			provider: buildProviderViewModel({
				label: providerLabel,
				status: snapshot?.status ?? "loading",
			}),
		};
	}

	public dispose(): void {
		this.#tick?.stop();
		this.#tick = undefined;
		for (const unsubscribe of this.#unsubscribes) {
			unsubscribe();
		}
		this.#unsubscribes.length = 0;
		this.#listeners.clear();
	}

	/**
	 * The elapsed-time readout only needs a timer while something is running and
	 * someone is watching; otherwise the plugin stays idle.
	 */
	#syncTick(): void {
		const watchers = this.#listeners.get("tick")?.size ?? 0;
		const working = this.#sessions.list().some((session) => session.state === "working");
		const wanted = watchers > 0 && working;

		if (wanted && this.#tick === undefined) {
			this.#tick = scheduleInterval(this.#tickIntervalMs, () => this.invalidate("tick"));
			return;
		}
		if (!wanted && this.#tick !== undefined) {
			this.#tick.stop();
			this.#tick = undefined;
		}
	}
}
