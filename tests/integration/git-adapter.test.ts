/**
 * Spike C — the git adapter against real repositories created on the fly.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitService, MIN_GIT_POLL_INTERVAL_MS } from "@/application/git-service.js";
import { GitCliAdapter } from "@/adapters/git/git-adapter.js";

const roots: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "AgentDeck Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "AgentDeck Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
}

let repo: string;
let clone: string;
let notARepo: string;

beforeAll(() => {
	repo = makeTempDir("agentdeck-git-");
	git(repo, "init", "--initial-branch=main", ".");
	writeFileSync(join(repo, "README.md"), "# repo\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-m", "initial");

	clone = makeTempDir("agentdeck-clone-");
	git(clone, "clone", repo, "work");
	clone = join(clone, "work");

	notARepo = makeTempDir("agentdeck-plain-");
	mkdirSync(join(notARepo, "sub"), { recursive: true });
});

afterAll(() => {
	for (const root of roots) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("git adapter", () => {
	const adapter = new GitCliAdapter();

	it("recognises a working tree", async () => {
		await expect(adapter.isRepository(repo)).resolves.toBe(true);
		await expect(adapter.isRepository(notARepo)).resolves.toBe(false);
	});

	it("reads the branch of a clean repository", async () => {
		const status = await adapter.getStatus(repo);
		expect(status).toMatchObject({
			branch: "main",
			detached: false,
			modified: 0,
			staged: 0,
			untracked: 0,
			ahead: 0,
			behind: 0,
		});
	});

	it("counts modified, staged and untracked files", async () => {
		writeFileSync(join(repo, "README.md"), "# repo\nchanged\n");
		writeFileSync(join(repo, "staged.txt"), "staged\n");
		writeFileSync(join(repo, "untracked.txt"), "untracked\n");
		git(repo, "add", "staged.txt");

		const status = await adapter.getStatus(repo);
		expect(status.modified).toBe(1);
		expect(status.staged).toBe(1);
		expect(status.untracked).toBe(1);
	});

	it("reports ahead and behind against an upstream", async () => {
		writeFileSync(join(clone, "local.txt"), "local\n");
		git(clone, "add", "local.txt");
		git(clone, "commit", "-m", "local change");

		const status = await adapter.getStatus(clone);
		expect(status.upstream).toBeDefined();
		expect(status.ahead).toBe(1);
		expect(status.behind).toBe(0);
	});

	it("reports a detached head", async () => {
		const head = git(clone, "rev-parse", "HEAD").trim();
		git(clone, "checkout", "--detach", head);
		const status = await adapter.getStatus(clone);
		expect(status.detached).toBe(true);
		expect(status.branch).toBeUndefined();
	});

	it("fails with GIT_NOT_REPOSITORY outside a working tree", async () => {
		await expect(adapter.getStatus(notARepo)).rejects.toMatchObject({ code: "GIT_NOT_REPOSITORY" });
	});

	it("fails with GIT_NOT_REPOSITORY for a path that does not exist", async () => {
		await expect(adapter.getStatus(join(notARepo, "missing"))).rejects.toMatchObject({
			code: "GIT_NOT_REPOSITORY",
		});
	});

	it("summarises the working-tree diff against HEAD (design §16.2)", async () => {
		const diffRepo = makeTempDir("agentdeck-diff-");
		git(diffRepo, "init", "--initial-branch=main", ".");
		writeFileSync(join(diffRepo, "a.txt"), "one\ntwo\nthree\n");
		writeFileSync(join(diffRepo, "b.txt"), "keep\n");
		git(diffRepo, "add", ".");
		git(diffRepo, "commit", "-m", "initial");

		// One file edited in the working tree, one staged, one untracked.
		writeFileSync(join(diffRepo, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
		writeFileSync(join(diffRepo, "b.txt"), "");
		git(diffRepo, "add", "b.txt");
		writeFileSync(join(diffRepo, "new.txt"), "brand new\n");

		const status = await adapter.getStatus(diffRepo);

		// Staged and unstaged both count; untracked does not, because `git diff`
		// does not see it and the deck already reports it as U:1.
		expect(status.diff).toEqual({ added: 2, removed: 1, fileCount: 2 });
		expect(status.untracked).toBe(1);
	});

	it("reports no diff for a clean tree", async () => {
		const cleanRepo = makeTempDir("agentdeck-clean-");
		git(cleanRepo, "init", "--initial-branch=main", ".");
		writeFileSync(join(cleanRepo, "a.txt"), "one\n");
		git(cleanRepo, "add", ".");
		git(cleanRepo, "commit", "-m", "initial");

		const status = await adapter.getStatus(cleanRepo);

		expect(status.diff).toEqual({ added: 0, removed: 0, fileCount: 0 });
	});

	it("still reports the branch when the diff cannot be read", async () => {
		// The branch and its counts are what the git key exists for; losing the
		// diff summary must not cost the user those.
		const failing = new GitCliAdapter({
			run: async (args) => {
				if (args.includes("--numstat")) {
					return { stdout: "", stderr: "boom", code: 128 };
				}
				return {
					stdout: ["# branch.oid 8f1e5c0d", "# branch.head main", "# branch.ab +0 -0", ""].join("\n"),
					stderr: "",
					code: 0,
				};
			},
		});

		const status = await failing.getStatus(repo);

		expect(status.branch).toBe("main");
		expect(status.diff).toBeUndefined();
	});

	it("reports a repository with no commits yet", async () => {
		const fresh = makeTempDir("agentdeck-fresh-");
		git(fresh, "init", "--initial-branch=main", ".");

		const status = await adapter.getStatus(fresh);
		expect(status.hasCommits).toBe(false);
		expect(status.branch).toBe("main");
		expect(status.detached).toBe(false);
	});

	it("classifies a non-repository by exit status, not by git's message language", async () => {
		// Force a localized git: the classification must be unaffected.
		const localized = new GitCliAdapter({
			run: async (args) => {
				if (args.includes("rev-parse")) {
					return { stdout: "", stderr: "致命的: Gitリポジトリではありません", code: 128 };
				}
				return { stdout: "", stderr: "致命的: Gitリポジトリではありません", code: 128 };
			},
		});
		await expect(localized.getStatus("/anywhere")).rejects.toMatchObject({ code: "GIT_NOT_REPOSITORY" });
	});

	it("keeps a real failure inside a repository distinct from a missing repository", async () => {
		const flaky = new GitCliAdapter({
			run: async (args) => {
				if (args.includes("rev-parse")) {
					return { stdout: "true\n", stderr: "", code: 0 };
				}
				return { stdout: "", stderr: "fatal: index file corrupt", code: 128 };
			},
		});
		await expect(flaky.getStatus("/repo")).rejects.toMatchObject({ code: "UNKNOWN" });
	});

	it("reports CLI_NOT_FOUND when git itself is missing", async () => {
		const missing = new GitCliAdapter({ executable: "definitely-not-git-xyz" });
		await expect(missing.getStatus(repo)).rejects.toMatchObject({ code: "CLI_NOT_FOUND" });
	});
});

describe("git service (design §16.3)", () => {
	it("caches a status and notifies watchers", async () => {
		const service = new GitService(new GitCliAdapter(), { pollIntervalMs: 60_000 });
		const seen: string[] = [];
		service.subscribe((entry) => seen.push(entry.path));

		const release = service.watch(repo);
		await service.refresh(repo);

		expect(service.get(repo)?.status?.branch).toBe("main");
		expect(seen).toContain(repo);
		release();
		service.dispose();
	});

	it("coalesces concurrent refreshes of the same repository", async () => {
		let calls = 0;
		const service = new GitService({
			isRepository: async () => true,
			getStatus: async (path) => {
				calls += 1;
				await new Promise((resolve) => setTimeout(resolve, 10));
				return {
					repositoryPath: path,
					detached: false,
					hasCommits: true,
					modified: 0,
					staged: 0,
					untracked: 0,
					conflicted: 0,
					ahead: 0,
					behind: 0,
				};
			},
		});

		await Promise.all([service.refresh("/a"), service.refresh("/a"), service.refresh("/a")]);
		expect(calls).toBe(1);
		service.dispose();
	});

	it("applies a changed poll interval and floors an unusable one", () => {
		const service = new GitService(new GitCliAdapter(), { pollIntervalMs: 60_000 });
		expect(service.pollIntervalMs).toBe(60_000);

		service.setPollInterval(30_000);
		expect(service.pollIntervalMs).toBe(30_000);

		// A Property Inspector `min` is not enforced when JS reads `value`.
		service.setPollInterval(5);
		expect(service.pollIntervalMs).toBe(MIN_GIT_POLL_INTERVAL_MS);

		service.setPollInterval(undefined);
		expect(service.pollIntervalMs).toBe(20_000);
		service.dispose();
	});

	it("caches the failure code instead of throwing at the caller", async () => {
		const service = new GitService(new GitCliAdapter());
		const entry = await service.refresh(notARepo);
		expect(entry.status).toBeUndefined();
		expect(entry.errorCode).toBe("GIT_NOT_REPOSITORY");
		service.dispose();
	});
});
