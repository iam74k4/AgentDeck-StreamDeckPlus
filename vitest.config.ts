import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Transpiles the modules that use TC39 decorators with TypeScript.
 *
 * The Stream Deck SDK registers actions with a standard class decorator. Vite's
 * oxc transform only lowers *legacy* decorators and leaves standard ones in
 * place, which Node cannot parse — so these files go through `tsc`, the same
 * compiler `rollup.config.mjs` uses for the shipped bundle.
 */
function decoratorTransform(): Plugin {
	return {
		name: "agentdeck:decorator-transform",
		enforce: "pre",
		transform(code, id) {
			if (!id.endsWith(".ts") || !/^\s*@[A-Za-z_$]/m.test(code)) {
				return null;
			}
			const output = ts.transpileModule(code, {
				fileName: id,
				compilerOptions: {
					target: ts.ScriptTarget.ES2022,
					module: ts.ModuleKind.ESNext,
					useDefineForClassFields: true,
					sourceMap: true,
					verbatimModuleSyntax: true,
				},
			});
			return { code: output.outputText, map: output.sourceMapText ?? null };
		},
	};
}

export default defineConfig({
	plugins: [decoratorTransform()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		testTimeout: 20_000,
		hookTimeout: 20_000,
	},
});
