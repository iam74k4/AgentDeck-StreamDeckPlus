/**
 * Model descriptors — design §19.
 *
 * Never hard-code a model list; providers report what they support.
 */

export interface ModelDescriptor {
	id: string;
	label: string;
	capabilities?: string[];
	reasoningLevels?: string[];
}

/** What the selector applies to a session: a model, and optionally an effort. */
export interface ModelSelection {
	modelId: string;
	reasoningLevel?: string;
}

/**
 * The choices a dial rotates through — design §19 "Rotate → Model / Effort".
 *
 * One entry per (model, reasoning level) pair, so a single rotation moves
 * through both dimensions in a predictable order instead of needing a mode
 * switch. Models without reasoning levels contribute a single entry.
 */
export function modelChoices(models: readonly ModelDescriptor[]): ModelSelection[] {
	const choices: ModelSelection[] = [];
	for (const model of models) {
		const levels = model.reasoningLevels ?? [];
		if (levels.length === 0) {
			choices.push({ modelId: model.id });
			continue;
		}
		for (const level of levels) {
			choices.push({ modelId: model.id, reasoningLevel: level });
		}
	}
	return choices;
}

export function isSameSelection(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
	return a?.modelId === b?.modelId && a?.reasoningLevel === b?.reasoningLevel;
}

/** Short, dial-sized label for a reasoning level. */
export function selectionLabel(models: readonly ModelDescriptor[], selection: ModelSelection): string {
	const model = models.find((candidate) => candidate.id === selection.modelId);
	return model?.label ?? selection.modelId;
}
