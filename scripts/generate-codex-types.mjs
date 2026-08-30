/**
 * Regenerates the official Codex protocol types.
 *
 * Design §9.6: when the Codex CLI can generate its own schema, do not hand-write
 * protocol types. This writes them into `src/generated/codex/`, which is
 * gitignored — the checked-in read model in `src/providers/codex/protocol.ts` is
 * what the build depends on, and `mapper.ts` is the single place that would move
 * over to the generated types.
 *
 * Usage: npm run codex:generate-types [-- --executable <path>]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "src", "generated", "codex");

const executableFlag = process.argv.indexOf("--executable");
const executable = executableFlag === -1 ? "codex" : (process.argv[executableFlag + 1] ?? "codex");

const result = spawnSync(executable, ["app-server", "generate-ts"], { encoding: "utf8" });

if (result.error?.code === "ENOENT") {
	console.error(`Codex CLI not found: ${executable}`);
	console.error("Install the Codex CLI, or pass --executable <path>.");
	process.exit(1);
}
if (result.status !== 0) {
	console.error(`\`${executable} app-server generate-ts\` exited with ${result.status}`);
	if (result.stderr) {
		console.error(result.stderr.trim());
	}
	process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const target = join(OUT_DIR, "protocol.ts");
writeFileSync(target, result.stdout);
console.log(`Wrote ${target}`);
