/**
 * Model descriptors — design §19.
 *
 * Never hard-code a model list; providers report what they support. Consumed by
 * the v0.4 model / reasoning selector, declared now to keep the boundary stable.
 */

export interface ModelDescriptor {
	id: string;
	label: string;
	capabilities?: string[];
	reasoningLevels?: string[];
}
