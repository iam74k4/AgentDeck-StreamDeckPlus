/**
 * The Property Inspector runtime — design §23.
 *
 * This layer had no coverage at all, and it is the surface a user actually
 * configures the plugin through. `pi.js` runs in the Stream Deck's embedded
 * browser, so it is evaluated here against the smallest DOM that can express the
 * behaviour it depends on.
 *
 * The stub models one browser rule deliberately: assigning a `<select>` a value
 * no option offers clears it. The first version of the option code leaned on
 * that rule without saying so, and left a removed project selected.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

const PI_SOURCE = readFileSync("com.agentdeck.streamdeck-plus.sdPlugin/ui/lib/pi.js", "utf8");

class FakeElement {
	public readonly tagName: string;
	public readonly dataset: Record<string, string> = {};
	public readonly children: FakeElement[] = [];
	public textContent = "";
	public id = "";
	public hidden = false;
	public type = "";
	public parent: FakeElement | undefined;
	readonly #attributes: Record<string, string> = {};
	#value = "";

	public constructor(tag: string) {
		this.tagName = tag.toUpperCase();
	}

	public get value(): string {
		return this.#value;
	}

	public set value(next: string) {
		if (this.tagName === "SELECT" && !this.children.some((child) => child.value === next)) {
			this.#value = "";
			return;
		}
		this.#value = next;
	}

	public appendChild(child: FakeElement): FakeElement {
		this.children.push(child);
		child.parent = this;
		return child;
	}

	public remove(): void {
		if (this.parent !== undefined) {
			const index = this.parent.children.indexOf(this);
			if (index >= 0) {
				this.parent.children.splice(index, 1);
			}
		}
	}

	public setAttribute(name: string, value: string): void {
		this.#attributes[name] = value;
	}

	public addEventListener(): void {}

	public querySelectorAll(selector: string): FakeElement[] {
		return selector === "option[data-generated]"
			? this.children.filter((child) => child.dataset.generated !== undefined)
			: [];
	}

	public querySelector(): FakeElement | null {
		return null;
	}
}

interface Harness {
	select: FakeElement;
	deliverProjects: (projects: unknown) => void;
	options: () => { value: string; label: string }[];
}

function start(settings: Record<string, unknown> = {}): Harness {
	const select = new FakeElement("select");
	select.id = "project-id";
	select.dataset.setting = "projectId";
	select.dataset.optionsFrom = "projects";
	const placeholder = new FakeElement("option");
	placeholder.value = "";
	select.appendChild(placeholder);

	const document = {
		activeElement: null,
		createElement: (tag: string) => new FakeElement(tag),
		querySelectorAll: (selector: string) =>
			selector === "[data-setting]" || selector === "[data-options-from]" ? [select] : [],
		querySelector: () => null,
	};

	interface FakeSocket {
		readyState: number;
		onopen?: () => void;
		onmessage?: (event: { data: string }) => void;
		send: () => void;
	}
	let socket: FakeSocket | undefined;
	// `pi.js` keeps the socket in a closure, so construction is how a test gets
	// hold of the instance whose `onmessage` it needs to drive.
	const FakeSocketClass = function (): FakeSocket {
		const instance: FakeSocket = { readyState: 1, send: () => {} };
		socket = instance;
		return instance;
	} as unknown as new () => FakeSocket;

	const context: Record<string, unknown> = {
		window: {},
		document,
		WebSocket: FakeSocketClass,
		console,
		setTimeout,
		clearTimeout,
	};
	vm.createContext(context);
	vm.runInContext(PI_SOURCE, context);

	const connect = (context.window as { connectElgatoStreamDeckSocket: (...args: unknown[]) => void })
		.connectElgatoStreamDeckSocket;
	connect(1234, "uuid", "register", "{}", JSON.stringify({ payload: { settings } }));

	return {
		select,
		deliverProjects: (projects) =>
			socket?.onmessage?.({
				data: JSON.stringify({ event: "didReceiveGlobalSettings", payload: { settings: { projects } } }),
			}),
		options: () => select.children.map((child) => ({ value: child.value, label: child.textContent })),
	};
}

const SAMPLE = [
	{ id: "p1", name: "game", path: "C:/work/Game" },
	{ id: "p2", name: "docs", path: "C:/work/Docs" },
];

describe("project dropdown (design §23.2)", () => {
	let harness: Harness;

	beforeEach(() => {
		harness = start({ projectId: "p2" });
	});

	it("lists the registered projects, keeping the placeholder", () => {
		harness.deliverProjects(SAMPLE);

		expect(harness.options()).toEqual([
			{ value: "", label: "" },
			{ value: "p1", label: "game" },
			{ value: "p2", label: "docs" },
		]);
	});

	it("restores the saved selection", () => {
		harness.deliverProjects(SAMPLE);
		expect(harness.select.value).toBe("p2");
	});

	it("does not duplicate options when the settings arrive again", () => {
		harness.deliverProjects(SAMPLE);
		harness.deliverProjects(SAMPLE);

		expect(harness.options()).toHaveLength(3);
	});

	it("clears a selection whose project was removed", () => {
		// Otherwise the panel keeps offering a project that no longer exists, and
		// the key it configures silently does nothing.
		harness.deliverProjects(SAMPLE);
		harness.deliverProjects([SAMPLE[0]]);

		expect(harness.options().map((option) => option.value)).toEqual(["", "p1"]);
		expect(harness.select.value).toBe("");
	});

	it("skips entries it cannot use, and falls back to the id for a blank name", () => {
		harness.deliverProjects([null, { name: "no id" }, { id: "p3", name: "" }]);

		expect(harness.options()).toEqual([
			{ value: "", label: "" },
			{ value: "p3", label: "p3" },
		]);
	});

	it("leaves just the placeholder when nothing is registered", () => {
		harness.deliverProjects(undefined);
		expect(harness.options()).toEqual([{ value: "", label: "" }]);
	});
});
