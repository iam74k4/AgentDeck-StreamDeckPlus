/**
 * Spike C — the git adapter against real repositories created on the fly.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitService } from "@/application/git-service.js";
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

	it("caches the failure code instead of throwing at the caller", async () => {
		const service = new GitService(new GitCliAdapter());
		const entry = await service.refresh(notARepo);
		expect(entry.status).toBeUndefined();
		expect(entry.errorCode).toBe("GIT_NOT_REPOSITORY");
		service.dispose();
	});
});
