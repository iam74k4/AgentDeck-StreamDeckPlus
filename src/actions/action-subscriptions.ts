/**
 * Per-instance subscription bookkeeping shared by the actions.
 *
 * `willAppear` and `willDisappear` fire on every profile switch, so an action can
 * be created and destroyed many times; leaking a listener there would leak on
 * every switch (instructions §8.3).
 */

import type { Unsubscribe } from "../domain/provider-events.js";

export class ActionSubscriptions {
	readonly #byAction = new Map<string, Unsubscribe[]>();

	public add(actionId: string, ...unsubscribes: Unsubscribe[]): void {
		const existing = this.#byAction.get(actionId) ?? [];
		existing.push(...unsubscribes);
		this.#byAction.set(actionId, existing);
	}

	public release(actionId: string): void {
		for (const unsubscribe of this.#byAction.get(actionId) ?? []) {
			unsubscribe();
		}
		this.#byAction.delete(actionId);
	}

	public releaseAll(): void {
		for (const actionId of [...this.#byAction.keys()]) {
			this.release(actionId);
		}
	}

	public get size(): number {
		return this.#byAction.size;
	}
}
