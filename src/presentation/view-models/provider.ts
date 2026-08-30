/**
 * Provider connection view model — design §21.1.
 *
 * Surfaces the Codex app-server lifecycle (design §9.5) so a failure is visible
 * on the deck rather than silently absent.
 */

import type { ProviderStatus } from "../../domain/usage.js";
import { providerStatusColor, Palette } from "./colors.js";

export interface ProviderViewModel {
	label: string;
	statusLabel: string;
	detail: string;
	color: string;
}

const STATUS_LABELS: Readonly<Record<ProviderStatus, string>> = {
	ready: "READY",
	loading: "…",
	stale: "STALE",
	"login-required": "LOGIN",
	"cli-not-found": "CLI?",
	"rate-limited": "LIMIT",
	error: "ERROR",
};

export function buildProviderViewModel(input: {
	label: string;
	status: ProviderStatus;
	lifecycle?: string;
}): ProviderViewModel {
	return {
		label: input.label,
		statusLabel: STATUS_LABELS[input.status],
		detail: input.lifecycle ?? "",
		color: input.status === "loading" ? Palette.idle : providerStatusColor(input.status),
	};
}
