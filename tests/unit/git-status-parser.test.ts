/**
 * Spike C — porcelain v2 parsing, including the non-repository failure path.
 */
import { describe, expect, it } from "vitest";
import { gitFailureToError } from "@/adapters/git/git-adapter.js";
import { parseGitStatusPorcelainV2 } from "@/adapters/git/git-status-parser.js";

const CLEAN = `# branch.oid 8f1e5c0d
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -0
`;

const DIRTY = `# branch.oid 8f1e5c0d
# branch.head feature/dials
# branch.upstream origin/feature/dials
# branch.ab +2 -3
1 .M N... 100644 100644 100644 aaa bbb src/plugin.ts
1 M. N... 100644 100644 100644 ccc ddd src/domain/usage.ts
1 MM N... 100644 100644 100644 eee fff README.md
2 R. N... 100644 100644 100644 ggg hhh R100 src/new.ts\tsrc/old.ts
u UU N... 100644 100644 100644 100644 iii jjj kkk src/conflict.ts
? notes.txt
? scratch/tmp.log
! ignored.txt
`;

describe("git status porcelain v2 (design §16.1)", () => {
	it("parses a clean repository", () => {
		const status = parseGitStatusPorcelainV2(CLEAN, "/repo");
		expect(status).toMatchObject({
			branch: "main",
			upstream: "origin/main",
			detached: false,
			modified: 0,
			staged: 0,
			untracked: 0,
			conflicted: 0,
			ahead: 0,
			behind: 0,
		});
	});

	it("counts staged, worktree, untracked and conflicted entries separately", () => {
		const status = parseGitStatusPorcelainV2(DIRTY, "/repo");
		expect(status.branch).toBe("feature/dials");
		expect(status.ahead).toBe(2);
		expect(status.behind).toBe(3);
		// `.M`, `MM` and the rename's worktree column are unchanged → 2 modified.
		expect(status.modified).toBe(2);
		// `M.`, `MM` and `R.` all have a staged column.
		expect(status.staged).toBe(3);
		expect(status.untracked).toBe(2);
		expect(status.conflicted).toBe(1);
	});

	it("ignores entries git marks as ignored", () => {
		expect(parseGitStatusPorcelainV2("! ignored.txt\n", "/repo").untracked).toBe(0);
	});

	it("flags a detached head", () => {
		const status = parseGitStatusPorcelainV2("# branch.oid abc\n# branch.head (detached)\n", "/repo");
		expect(status.detached).toBe(true);
		expect(status.branch).toBeUndefined();
	});

	it("handles a repository with no commits and no upstream", () => {
		const status = parseGitStatusPorcelainV2("# branch.oid (initial)\n# branch.head main\n", "/repo");
		expect(status.branch).toBe("main");
		expect(status.upstream).toBeUndefined();
		expect(status.ahead).toBe(0);
		// A fresh repository is on a branch; it is not detached.
		expect(status.hasCommits).toBe(false);
		expect(status.detached).toBe(false);
	});

	it("reports hasCommits for a repository with history", () => {
		expect(parseGitStatusPorcelainV2(CLEAN, "/repo").hasCommits).toBe(true);
	});

	it("tolerates CRLF line endings", () => {
		expect(parseGitStatusPorcelainV2(CLEAN.replace(/\n/g, "\r\n"), "/repo").branch).toBe("main");
	});

	it("classifies a failure by whether the path is a work tree, not by message text", () => {
		expect(gitFailureToError("/tmp", false).code).toBe("GIT_NOT_REPOSITORY");
		expect(gitFailureToError("/repo", true).code).toBe("UNKNOWN");
	});
});
