/**
 * Model / reasoning selector — design §19.
 *
 * The property that matters: rotating changes nothing. A dial nudged while
 * reaching past the deck must not switch the model a running agent is using.
 */

import { describe, expect, it, vi } from "vitest";
import { ModelService } from "@/application/model-service.js";
import { ProviderRegistry } from "@/application/provider-registry.js";
import { SessionService } from "@/application/session-service.js";
import { modelChoices, type ModelDescriptor } from "@/domain/model.js";
import { buildModelViewModel } from "@/presentation/view-models/model.js";
import { ControllableProvider } from "../helpers/fake-runtime.js";

function setup(): { models: ModelService; provider: ControllableProvider; sessions: SessionService } {
	const registry = new ProviderRegistry();
	const provider = new ControllableProvider();
	registry.register(provider);
	const sessions = new SessionService(registry);
	return { models: new ModelService(registry, sessions), provider, sessions };
}

describe("modelChoices", () => {
	it("expands each model into one entry per reasoning level", () => {
		const models: ModelDescriptor[] = [
			{ id: "a", label: "A", reasoningLevels: ["low", "high"] },
			{ id: "b", label: "B" },
		];
		expect(modelChoices(models)).toEqual([
			{ modelId: "a", reasoningLevel: "low" },
			{ modelId: "a", reasoningLevel: "high" },
			{ modelId: "b" },
		]);
	});
});

describe("ModelService", () => {
	it("reports the provider's list rather than a hard-coded one", async () => {
		const { models, provider } = setup();
		provider.models = [{ id: "custom-model", label: "Custom" }];
		await models.refresh("codex");

		expect(models.getState("codex").models).toEqual([{ id: "custom-model", label: "Custom" }]);
	});

	it("shares one request between concurrent callers", async () => {
		const { models, provider } = setup();
		const spy = vi.spyOn(provider, "getModels");

		await Promise.all([models.refresh("codex"), models.refresh("codex"), models.refresh("codex")]);

		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("rotating moves the highlight and applies nothing", async () => {
		const { models, provider } = setup();
		await models.refresh("codex");

		models.rotate("codex", 1);
		models.rotate("codex", 1);

		expect(models.getState("codex").highlighted).toEqual({ modelId: "gpt-5.1" });
		expect(provider.applied).toEqual([]);
	});

	it("wraps in both directions", async () => {
		const { models } = setup();
		await models.refresh("codex");

		models.rotate("codex", -1);
		expect(models.getState("codex").highlighted).toEqual({ modelId: "gpt-5.1" });

		models.rotate("codex", 1);
		expect(models.getState("codex").highlighted).toEqual({
			modelId: "gpt-5.1-codex",
			reasoningLevel: "medium",
		});
	});

	it("applies to the active session on press", async () => {
		const { models, provider } = setup();
		provider.pushSession({ id: "thr_1", providerId: "codex", state: "working", updatedAt: new Date() });
		await models.refresh("codex");
		models.rotate("codex", 1);

		await expect(models.apply("codex")).resolves.toEqual({
			modelId: "gpt-5.1-codex",
			reasoningLevel: "high",
		});
		expect(provider.applied).toEqual([
			{ sessionId: "thr_1", selection: { modelId: "gpt-5.1-codex", reasoningLevel: "high" } },
		]);
	});

	it("refuses to apply when there is no session to apply to", async () => {
		const { models } = setup();
		await models.refresh("codex");

		await expect(models.apply("codex")).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
	});

	it("starts the highlight on what the session is already running", async () => {
		const { models, provider } = setup();
		provider.pushSession({
			id: "thr_1",
			providerId: "codex",
			state: "working",
			updatedAt: new Date(),
			modelId: "gpt-5.1",
		});
		await models.refresh("codex");

		expect(models.getState("codex").highlighted).toEqual({ modelId: "gpt-5.1" });
	});

	it("keeps a failed lookup out of the way instead of throwing at the caller", async () => {
		const { models, provider } = setup();
		provider.modelsFail = true;

		await expect(models.refresh("codex")).resolves.toBeUndefined();
		expect(models.getState("codex").error?.code).toBe("UNKNOWN");
	});
});

describe("the model segment", () => {
	it("marks a rotated-but-unapplied choice as needing a press", async () => {
		const { models, provider } = setup();
		provider.pushSession({
			id: "thr_1",
			providerId: "codex",
			state: "working",
			updatedAt: new Date(),
			modelId: "gpt-5.1-codex",
			reasoningLevel: "medium",
		});
		await models.refresh("codex");

		expect(buildModelViewModel(models.getState("codex"))).toMatchObject({
			title: "GPT-5.1 Codex",
			detail: "medium",
			dirty: false,
		});

		models.rotate("codex", 1);
		expect(buildModelViewModel(models.getState("codex"))).toMatchObject({
			detail: "high · press",
			dirty: true,
		});
	});

	it("renders as unavailable when the provider cannot select a model", () => {
		const registry = new ProviderRegistry();
		const sessions = new SessionService(registry);
		const models = new ModelService(registry, sessions);

		expect(buildModelViewModel(models.getState("claude"))).toMatchObject({
			available: false,
			detail: "not supported",
		});
	});
});
