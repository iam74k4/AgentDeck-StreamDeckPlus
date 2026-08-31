/**
 * Approve key — design §12.4, §22.2.
 *
 *   ┌────────┬────────┐
 *   │ HOLD   │  DENY  │
 *   │APPROVE │        │
 *   └────────┴────────┘
 *
 * A low- or medium-risk request is approved on press. A high-risk one has to be
 * held, and the ring fills while it is: instructions §2.5 requires the hold, and
 * the ring is what makes a hold distinguishable from a key that did nothing.
 *
 * Whatever the path, the only thing this key can send is Approve Once. There is
 * no setting, gesture or repeat that turns it into a standing approval.
 */

import { action, SingletonAction } from "@elgato/streamdeck";
import type {
	DidReceiveSettingsEvent,
	KeyAction,
	KeyDownEvent,
	KeyUpEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import { requiresHoldToApprove } from "../domain/approval.js";
import { renderApprovalKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { buildApproveKeyViewModel } from "../presentation/view-models/approval.js";
import type { AgentDeckRuntime } from "../runtime.js";
import { ActionSubscriptions } from "./action-subscriptions.js";
import { bindRenderer } from "./renderer-binding.js";
import type { ApprovalActionSettings } from "./settings.js";

const CONCERNS: readonly UiConcern[] = ["approval"];

/** Long enough to be deliberate, short enough not to feel broken. */
export const DEFAULT_HOLD_MS = 1_200;
const HOLD_FRAME_MS = 80;
/** Guards against a Property Inspector value that would defeat the hold. */
const MIN_HOLD_MS = 500;
const MAX_HOLD_MS = 5_000;

export function holdDurationMs(settings: ApprovalActionSettings): number {
	const seconds = settings.holdSeconds;
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
		return DEFAULT_HOLD_MS;
	}
	return Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, Math.round(seconds * 1_000)));
}

interface Hold {
	timer: NodeJS.Timeout;
	startedAt: number;
	durationMs: number;
	/**
	 * The request the hold was started against.
	 *
	 * A hold takes a second, and the queue can move underneath it. Approving
	 * "whatever is current now" would let a hold begun on the request the user
	 * read approve a different one they never saw.
	 */
	approvalId: string;
}

@action({ UUID: "com.agentdeck.streamdeck-plus.approve" })
export class ApproveAction extends SingletonAction<ApprovalActionSettings> {
	readonly #runtime: AgentDeckRuntime;
	readonly #subscriptions = new ActionSubscriptions();
	readonly #holds = new Map<string, Hold>();

	public constructor(runtime: AgentDeckRuntime) {
		super();
		this.#runtime = runtime;
	}

	public override onWillAppear(ev: WillAppearEvent<ApprovalActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override onWillDisappear(ev: WillDisappearEvent<ApprovalActionSettings>): void {
		this.#cancelHold(ev.action.id);
		this.#subscriptions.release(ev.action.id);
	}

	public override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ApprovalActionSettings>): void {
		if (ev.action.isKey()) {
			this.#bind(ev.action, ev.payload.settings);
		}
	}

	public override async onKeyDown(ev: KeyDownEvent<ApprovalActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		const settings = ev.payload.settings;
		const pending = this.#current(settings);
		if (pending === undefined) {
			await ev.action.showAlert();
			return;
		}
		if (!requiresHoldToApprove(pending.request)) {
			await this.#approve(ev.action, settings, pending.request.id);
			return;
		}
		this.#startHold(ev.action, settings, pending.request.id);
	}

	/** Releasing early cancels: a partial hold approves nothing. */
	public override onKeyUp(ev: KeyUpEvent<ApprovalActionSettings>): void {
		if (this.#cancelHold(ev.action.id) && ev.action.isKey()) {
			void this.#render(ev.action, ev.payload.settings);
		}
	}

	#startHold(
		target: KeyAction<ApprovalActionSettings>,
		settings: ApprovalActionSettings,
		approvalId: string,
	): void {
		this.#cancelHold(target.id);
		const durationMs = holdDurationMs(settings);
		const startedAt = Date.now();
		const timer = setInterval(() => {
			// If the request went away — answered elsewhere, or the provider
			// disconnected — the hold has nothing left to approve.
			if (this.#current(settings)?.request.id !== approvalId) {
				this.#cancelHold(target.id);
				void this.#render(target, settings);
				return;
			}
			const elapsed = Date.now() - startedAt;
			if (elapsed >= durationMs) {
				this.#cancelHold(target.id);
				void this.#approve(target, settings, approvalId);
				return;
			}
			void this.#render(target, settings, elapsed / durationMs);
		}, HOLD_FRAME_MS);
		timer.unref?.();

		this.#holds.set(target.id, { timer, startedAt, durationMs, approvalId });
		void this.#render(target, settings, 0);
	}

	#cancelHold(actionId: string): boolean {
		const hold = this.#holds.get(actionId);
		if (hold === undefined) {
			return false;
		}
		clearInterval(hold.timer);
		this.#holds.delete(actionId);
		return true;
	}

	async #approve(
		target: KeyAction<ApprovalActionSettings>,
		settings: ApprovalActionSettings,
		approvalId: string,
	): Promise<void> {
		try {
			// By id, not "whatever is current": the key answers the request it drew.
			await this.#runtime.approvals.resolve(approvalId, "approve-once");
			await target.showOk();
		} catch (error) {
			this.#runtime.logger.warn("approve failed", error);
			await target.showAlert();
		}
		await this.#render(target, settings);
	}

	#current(settings: ApprovalActionSettings) {
		return this.#runtime.ui.getCurrentApproval(providerFilter(settings));
	}

	#bind(target: KeyAction<ApprovalActionSettings>, settings: ApprovalActionSettings): void {
		bindRenderer({
			subscriptions: this.#subscriptions,
			ui: this.#runtime.ui,
			target,
			settings,
			concerns: CONCERNS,
			render: (key, current) => this.#render(key, current),
		});
	}

	async #render(
		target: KeyAction<ApprovalActionSettings>,
		settings: ApprovalActionSettings,
		holdProgress = 0,
	): Promise<void> {
		const pending = this.#current(settings);
		await target.setImage(
			renderApprovalKey(
				buildApproveKeyViewModel({
					...(pending === undefined ? {} : { request: pending.request }),
					holdProgress,
				}),
			),
		);
	}
}

/** An empty provider setting means "whichever provider is asking". */
export function providerFilter(settings: ApprovalActionSettings): string | undefined {
	const providerId = settings.providerId;
	return typeof providerId === "string" && providerId.length > 0 ? providerId : undefined;
}
