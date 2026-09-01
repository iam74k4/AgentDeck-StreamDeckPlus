/**
 * Deny key — design §12.4, §22.2 ("Denyは即時押下可").
 *
 * Refusing is always one press: making the safe answer harder than the unsafe
 * one would be exactly backwards. It denies this one request and lets the agent
 * carry on; stopping the turn outright is the STOP key (design §12.2).
 */

import { action } from "@elgato/streamdeck";
import type { KeyAction, KeyDownEvent } from "@elgato/streamdeck";
import { renderApprovalKey } from "../presentation/renderers/key-renderer.js";
import type { UiConcern } from "../presentation/ui-coordinator.js";
import { buildDenyKeyViewModel } from "../presentation/view-models/approval.js";
import { RenderedKeyAction } from "./rendered-key-action.js";
import { providerFilter } from "./approve-action.js";
import type { ApprovalActionSettings } from "./settings.js";

@action({ UUID: "com.agentdeck.streamdeck-plus.deny" })
export class DenyAction extends RenderedKeyAction<ApprovalActionSettings> {
	protected override get concerns(): readonly UiConcern[] {
		return ["approval"];
	}

	public override async onKeyDown(ev: KeyDownEvent<ApprovalActionSettings>): Promise<void> {
		if (!ev.action.isKey()) {
			return;
		}
		const settings = ev.payload.settings;
		const pending = this.runtime.ui.getCurrentApproval(providerFilter(settings));
		if (pending === undefined) {
			await ev.action.showAlert();
			return;
		}
		try {
			// By id, so the key answers the request it drew rather than whatever
			// happens to be at the head of the queue by the time the press lands.
			await this.runtime.approvals.resolve(pending.request.id, "deny");
			await ev.action.showOk();
		} catch (error) {
			this.runtime.logger.warn("deny failed", error);
			await ev.action.showAlert();
		}
		await this.render(ev.action, settings);
	}

	protected override async render(
		target: KeyAction<ApprovalActionSettings>,
		settings: ApprovalActionSettings,
	): Promise<void> {
		const pending = this.runtime.ui.getCurrentApproval(providerFilter(settings));
		await target.setImage(
			renderApprovalKey(buildDenyKeyViewModel(pending === undefined ? {} : { request: pending.request })),
		);
	}
}
