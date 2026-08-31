/**
 * v0.1 Control Core — project registration/switching (instructions §4) and the
 * app launcher (design §11).
 */
import { describe, expect, it, vi } from "vitest";
import { ProjectService, type ProjectState, type ProjectStore } from "@/application/project-service.js";
import {
	BUILT_IN_APPS,
	LauncherRegistry,
	ProcessAppLauncher,
	type AppDefinition,
} from "@/adapters/launcher/app-launcher.js";
import { buildProjectViewModel } from "@/presentation/view-models/project.js";
import { renderLauncherKey, renderProjectKey } from "@/presentation/renderers/key-renderer.js";

function store(initial: ProjectState = { projects: [] }): ProjectStore & { saved: ProjectState[] } {
	let state = initial;
	const saved: ProjectState[] = [];
	return {
		saved,
		load: async () => state,
		save: async (next) => {
			state = next;
			saved.push(next);
		},
	};
}

function service(
	options: { store?: ReturnType<typeof store>; exists?: boolean; isDirectory?: boolean } = {},
) {
	let n = 0;
	return new ProjectService({
		store: options.store ?? store(),
		stat: async () => ({ exists: options.exists ?? true, isDirectory: options.isDirectory ?? true }),
		idFactory: () => `prj_${++n}`,
	});
}

describe("project registration", () => {
	it("registers a project and makes the first one active", async () => {
		const projects = service();
		await projects.load();

		const project = await projects.add({ path: "/src/game" });
		expect(project).toMatchObject({ id: "prj_1", name: "game", path: "/src/game" });
		expect(projects.getActive()?.id).toBe("prj_1");
	});

	it("derives a name but keeps one the user supplied", async () => {
		const projects = service();
		await projects.load();

		expect((await projects.add({ path: "C:\\src\\game" })).name).toBe("game");
		expect((await projects.add({ path: "/src/other", name: "  Other  " })).name).toBe("Other");
	});

	it("updates in place rather than duplicating the same path", async () => {
		const projects = service();
		await projects.load();

		const first = await projects.add({ path: "C:\\src\\game" });
		// Windows paths are case-insensitive and take either separator.
		const again = await projects.add({ path: "c:/SRC/Game/", name: "Renamed" });

		expect(again.id).toBe(first.id);
		expect(projects.list()).toHaveLength(1);
		expect(projects.list()[0]?.name).toBe("Renamed");
	});

	it("refuses a path that fails validation", async () => {
		const projects = service();
		await projects.load();
		await expect(projects.add({ path: "relative/path" })).rejects.toMatchObject({ code: "INVALID_PROJECT" });

		const missing = service({ exists: false });
		await missing.load();
		await expect(missing.add({ path: "/nope" })).rejects.toMatchObject({ code: "INVALID_PROJECT" });

		const file = service({ isDirectory: false });
		await file.load();
		await expect(file.add({ path: "/a/file.txt" })).rejects.toMatchObject({ code: "INVALID_PROJECT" });
	});

	it("persists through the injected store", async () => {
		const backing = store();
		const projects = service({ store: backing });
		await projects.load();
		await projects.add({ path: "/src/game" });

		// A fresh service over the same store sees the same projects.
		const reloaded = new ProjectService({ store: backing });
		const state = await reloaded.load();
		expect(state.projects).toHaveLength(1);
		expect(reloaded.getActive()?.path).toBe("/src/game");
	});

	it("drops persisted entries that are not usable projects", async () => {
		const projects = new ProjectService({
			store: store({
				projects: [
					{ id: "", path: "/a" },
					{ id: "ok", path: "" },
				] as never,
			}),
		});
		expect((await projects.load()).projects).toEqual([]);
	});

	it("recovers from a store that cannot be read", async () => {
		const projects = new ProjectService({
			store: {
				load: async () => {
					throw new Error("corrupt");
				},
				save: async () => {},
			},
		});
		await expect(projects.load()).resolves.toMatchObject({ projects: [] });
		expect(projects.loaded).toBe(true);
	});

	it("keeps the in-memory change when the store fails to save", async () => {
		const projects = new ProjectService({
			store: {
				load: async () => ({ projects: [] }),
				save: async () => {
					throw new Error("disk full");
				},
			},
			stat: async () => ({ exists: true, isDirectory: true }),
		});
		await projects.load();

		await expect(projects.add({ path: "/src/game" })).resolves.toBeDefined();
		expect(projects.list()).toHaveLength(1);
	});
});

describe("project switching", () => {
	it("activates, cycles and wraps", async () => {
		const projects = service();
		await projects.load();
		const a = await projects.add({ path: "/a" });
		const b = await projects.add({ path: "/b" });

		expect(projects.getActive()?.id).toBe(a.id);
		await projects.cycle(1);
		expect(projects.getActive()?.id).toBe(b.id);
		await projects.cycle(1);
		expect(projects.getActive()?.id).toBe(a.id);
		await projects.cycle(-1);
		expect(projects.getActive()?.id).toBe(b.id);
	});

	it("returns nothing to cycle when there are no projects", async () => {
		const projects = service();
		await projects.load();
		await expect(projects.cycle(1)).resolves.toBeUndefined();
	});

	it("refuses to activate a project that does not exist", async () => {
		const projects = service();
		await projects.load();
		await expect(projects.activate("nope")).rejects.toMatchObject({ code: "INVALID_PROJECT" });
	});

	it("moves the active project on when the active one is removed", async () => {
		const projects = service();
		await projects.load();
		const a = await projects.add({ path: "/a" });
		await projects.add({ path: "/b" });
		await projects.activate(a.id);

		await projects.remove(a.id);
		expect(projects.getActive()?.path).toBe("/b");

		await projects.remove(projects.getActive()!.id);
		expect(projects.getActive()).toBeUndefined();
	});

	it("falls back when the persisted active id is gone", async () => {
		const projects = new ProjectService({
			store: store({ projects: [{ id: "p1", name: "a", path: "/a" }], activeProjectId: "vanished" }),
		});
		await projects.load();
		expect(projects.getActive()?.id).toBe("p1");
	});

	it("notifies subscribers on every change", async () => {
		const projects = service();
		const seen: number[] = [];
		projects.subscribe((state) => seen.push(state.projects.length));

		await projects.load();
		await projects.add({ path: "/a" });
		expect(seen).toEqual([0, 1]);
	});
});

describe("app launcher", () => {
	const definition: AppDefinition = {
		id: "vscode",
		displayName: "VS Code",
		command: "code",
		project: "argument",
	};

	function launcher(overrides: Partial<AppDefinition> = {}, options: { missing?: boolean } = {}) {
		const resolved = options.missing === true ? undefined : "/usr/bin/code";
		const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
		const instance = new ProcessAppLauncher({
			definition: { ...definition, ...overrides },
			resolve: () => resolved,
			spawnProcess: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
				calls.push({ command, args, options });
				return { on: () => {}, unref: () => {} } as never;
			}) as never,
		});
		return { instance, calls };
	}

	it("passes the project as an argument when the app takes one", async () => {
		const { instance, calls } = launcher();
		await instance.launch({ projectPath: "/src/game" });

		expect(calls[0]?.command).toBe("/usr/bin/code");
		expect(calls[0]?.args).toEqual(["/src/game"]);
	});

	it("starts in the project directory when that is the app's convention", async () => {
		const { instance, calls } = launcher({ project: "cwd" });
		await instance.launch({ projectPath: "/src/game" });

		expect(calls[0]?.args).toEqual([]);
		expect(calls[0]?.options.cwd).toBe("/src/game");
	});

	it("never goes through a shell, so a path cannot become a command", async () => {
		const { instance, calls } = launcher();
		await instance.launch({ projectPath: '/src/game" & calc.exe' });

		expect(calls[0]?.options.shell).toBe(false);
		// The whole thing is one argument, not two commands.
		expect(calls[0]?.args).toEqual(['/src/game" & calc.exe']);
	});

	it("detaches so the launched app does not hold the plugin open", async () => {
		const { instance, calls } = launcher();
		await instance.launch();
		expect(calls[0]?.options.detached).toBe(true);
		expect(calls[0]?.options.stdio).toBe("ignore");
	});

	it("reports CLI_NOT_FOUND rather than spawning nothing silently", async () => {
		const { instance, calls } = launcher({}, { missing: true });
		await expect(instance.isInstalled()).resolves.toBe(false);
		await expect(instance.launch()).rejects.toMatchObject({ code: "CLI_NOT_FOUND" });
		expect(calls).toEqual([]);
	});

	it("ignores the project when the app has no use for one", async () => {
		const { instance, calls } = launcher({ project: "none" });
		await instance.launch({ projectPath: "/src/game" });
		expect(calls[0]?.args).toEqual([]);
		expect(calls[0]?.options.cwd).toBeUndefined();
	});
});

describe("launcher registry", () => {
	it("ships the apps instructions §4 names", () => {
		const ids = BUILT_IN_APPS.map((app) => app.id);
		expect(ids).toContain("vscode");
		expect(ids).toContain("terminal");
		expect(ids).toContain("codex");
	});

	it("resolves a built-in app by id", () => {
		const registry = new LauncherRegistry();
		expect(registry.resolve({ appId: "vscode" })?.displayName).toBe("VS Code");
		expect(registry.list().length).toBe(BUILT_IN_APPS.length);
	});

	it("builds a launcher for a user-supplied command", () => {
		const registry = new LauncherRegistry();
		const custom = registry.resolve({ command: "  my-tool  " });
		expect(custom?.displayName).toBe("my-tool");
	});

	it("returns nothing when neither an app nor a command is configured", () => {
		const registry = new LauncherRegistry();
		expect(registry.resolve({})).toBeUndefined();
		expect(registry.resolve({ appId: "", command: "  " })).toBeUndefined();
	});

	it("falls back to the command when the app id is unknown", () => {
		const registry = new LauncherRegistry();
		expect(registry.resolve({ appId: "nope", command: "fallback" })?.displayName).toBe("fallback");
	});
});

describe("project rendering", () => {
	it("shows the active project and how many there are", () => {
		const vm = buildProjectViewModel({
			active: { id: "p1", name: "game", path: "/src/game" },
			total: 3,
		});
		expect(vm.name).toBe("game");
		expect(vm.detail).toBe("3 projects");
		expect(decodeURIComponent(renderProjectKey(vm))).toContain("game");
	});

	it("prefers the branch when git knows one", () => {
		const vm = buildProjectViewModel({
			active: { id: "p1", name: "game", path: "/src/game" },
			total: 1,
			gitSummary: "main",
		});
		expect(vm.detail).toBe("main");
	});

	it("says so when nothing is registered", () => {
		const vm = buildProjectViewModel({ total: 0 });
		expect(vm.name).toBe("NO PROJECT");
		expect(vm.available).toBe(false);
		expect(decodeURIComponent(renderProjectKey(vm))).toContain('opacity="0.35"');
	});

	it("dims a launcher key for an app that is not installed", () => {
		const missing = decodeURIComponent(
			renderLauncherKey({ name: "VS Code", detail: "not found", installed: false }),
		);
		expect(missing).toContain('opacity="0.35"');
		expect(missing).toContain("not found");

		const present = decodeURIComponent(
			renderLauncherKey({ name: "VS Code", detail: "game", installed: true }),
		);
		expect(present).toContain('opacity="1"');
	});
});

void vi;
