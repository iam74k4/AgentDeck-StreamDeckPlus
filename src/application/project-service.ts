/**
 * Project service — design §7.1, §3.4, instructions §4.
 *
 * A Project binds a local directory to an AI working context. It is kept
 * deliberately separate from AgentSession and from ProviderId: "which repository"
 * , "which agent session" and "which provider" are three different questions, and
 * conflating them is what the design calls out in §3.4.
 *
 * Persistence is injected, so this layer never learns that Stream Deck's global
 * settings are where projects happen to live.
 */

import type { Unsubscribe } from "../domain/provider-events.js";
import { AgentDeckError } from "../domain/errors.js";
import {
	deriveProjectName,
	validateProjectPath,
	type Project,
	type ProjectValidation,
} from "../domain/project.js";
import type { Logger } from "../infrastructure/logger.js";

export interface ProjectState {
	projects: Project[];
	activeProjectId?: string;
}

export interface ProjectStore {
	load(): Promise<ProjectState>;
	save(state: ProjectState): Promise<void>;
}

/** Filesystem facts the domain validator needs but must not read for itself. */
export type PathStat = (path: string) => Promise<{ exists: boolean; isDirectory: boolean }>;

export interface ProjectServiceOptions {
	store: ProjectStore;
	stat?: PathStat;
	logger?: Logger;
	idFactory?: () => string;
}

export type ProjectListener = (state: ProjectState) => void;

export class ProjectService {
	readonly #store: ProjectStore;
	readonly #stat: PathStat | undefined;
	readonly #logger: Logger | undefined;
	readonly #idFactory: () => string;
	readonly #listeners = new Set<ProjectListener>();

	#projects: Project[] = [];
	#activeProjectId: string | undefined;
	#loaded = false;

	public constructor(options: ProjectServiceOptions) {
		this.#store = options.store;
		this.#stat = options.stat;
		this.#logger = options.logger?.child("project");
		this.#idFactory = options.idFactory ?? (() => `prj_${Math.random().toString(36).slice(2, 10)}`);
	}

	public subscribe(listener: ProjectListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Reads persisted projects. Safe to call more than once. */
	public async load(): Promise<ProjectState> {
		try {
			const state = await this.#store.load();
			this.#projects = [...(state.projects ?? [])].filter((project) => isUsable(project));
			this.#activeProjectId = this.#resolveActive(state.activeProjectId);
		} catch (error) {
			this.#logger?.warn("failed to load projects", error);
			this.#projects = [];
			this.#activeProjectId = undefined;
		}
		this.#loaded = true;
		this.#notify();
		return this.state;
	}

	public get state(): ProjectState {
		return {
			projects: [...this.#projects],
			...(this.#activeProjectId === undefined ? {} : { activeProjectId: this.#activeProjectId }),
		};
	}

	public list(): Project[] {
		return [...this.#projects];
	}

	public get(id: string): Project | undefined {
		return this.#projects.find((project) => project.id === id);
	}

	public getActive(): Project | undefined {
		return this.#activeProjectId === undefined ? undefined : this.get(this.#activeProjectId);
	}

	/** Shape and filesystem validation, without registering anything. */
	public async validate(path: string): Promise<ProjectValidation> {
		const shape = validateProjectPath(path);
		if (!shape.valid || this.#stat === undefined) {
			return shape;
		}
		try {
			return validateProjectPath(path, await this.#stat(path));
		} catch (error) {
			this.#logger?.debug("could not stat project path", error);
			return shape;
		}
	}

	/**
	 * Registers a project. Re-registering the same path updates it in place rather
	 * than creating a duplicate the user would then have to clean up.
	 */
	public async add(input: { path: string; name?: string; preferredProviderId?: string }): Promise<Project> {
		const path = input.path.trim();
		const validation = await this.validate(path);
		if (!validation.valid) {
			throw new AgentDeckError("INVALID_PROJECT", validation.message ?? "Invalid project path.");
		}

		const existing = this.#projects.find((project) => samePath(project.path, path));
		const project: Project = {
			id: existing?.id ?? this.#idFactory(),
			name: input.name?.trim() ?? existing?.name ?? deriveProjectName(path),
			path,
			...(input.preferredProviderId === undefined
				? existing?.preferredProviderId === undefined
					? {}
					: { preferredProviderId: existing.preferredProviderId }
				: { preferredProviderId: input.preferredProviderId }),
		};

		this.#projects =
			existing === undefined
				? [...this.#projects, project]
				: this.#projects.map((candidate) => (candidate.id === project.id ? project : candidate));

		this.#activeProjectId ??= project.id;
		await this.#persist();
		return project;
	}

	public async remove(id: string): Promise<void> {
		this.#projects = this.#projects.filter((project) => project.id !== id);
		if (this.#activeProjectId === id) {
			this.#activeProjectId = this.#projects[0]?.id;
		}
		await this.#persist();
	}

	public async activate(id: string): Promise<Project> {
		const project = this.get(id);
		if (project === undefined) {
			throw new AgentDeckError("INVALID_PROJECT", `No such project: ${id}`);
		}
		this.#activeProjectId = id;
		await this.#persist();
		return project;
	}

	/** Steps to the next or previous project; used by the project dial. */
	public async cycle(direction: 1 | -1): Promise<Project | undefined> {
		if (this.#projects.length === 0) {
			return undefined;
		}
		const index = this.#projects.findIndex((project) => project.id === this.#activeProjectId);
		const next = this.#projects[(index + direction + this.#projects.length) % this.#projects.length];
		return next === undefined ? undefined : this.activate(next.id);
	}

	public get loaded(): boolean {
		return this.#loaded;
	}

	public dispose(): void {
		this.#listeners.clear();
	}

	#resolveActive(candidate: string | undefined): string | undefined {
		if (candidate !== undefined && this.#projects.some((project) => project.id === candidate)) {
			return candidate;
		}
		return this.#projects[0]?.id;
	}

	async #persist(): Promise<void> {
		const state = this.state;
		try {
			await this.#store.save(state);
		} catch (error) {
			// A failed save must not lose the in-memory change the user just made.
			this.#logger?.warn("failed to persist projects", error);
		}
		this.#notify();
	}

	#notify(): void {
		const state = this.state;
		for (const listener of this.#listeners) {
			try {
				listener(state);
			} catch (error) {
				this.#logger?.warn("project listener failed", error);
			}
		}
	}
}

function isUsable(project: Project | undefined): project is Project {
	return (
		project !== undefined &&
		typeof project.id === "string" &&
		project.id.length > 0 &&
		typeof project.path === "string" &&
		project.path.length > 0
	);
}

/** Windows paths are case-insensitive and tolerate either separator. */
function samePath(a: string, b: string): boolean {
	const normalise = (value: string): string =>
		value
			.replace(/[\\/]+$/, "")
			.replace(/\\/g, "/")
			.toLowerCase();
	return normalise(a) === normalise(b);
}
