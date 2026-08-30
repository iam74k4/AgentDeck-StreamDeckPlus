import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * Dependency direction (instructions §2.3 / §6, design §8):
 *
 *   Presentation → Application → Domain ← Infrastructure / Providers / Adapters
 *
 * Domain and Application may reference a *port* (an abstract interface such as
 * `AgentProvider` or `GitAdapter`) as a type, but must never import a concrete
 * adapter at runtime, and must never see a Codex/Claude wire shape at all.
 */
const layerBoundary = {
	"@typescript-eslint/no-restricted-imports": [
		"error",
		{
			patterns: [
				{
					group: ["**/providers/codex/**", "**/providers/claude/**", "**/generated/**"],
					message:
						"Provider-specific schemas must not leave the provider adapter (instructions §2.3, design §3.3).",
				},
				{
					group: ["@elgato/streamdeck", "@elgato/streamdeck/*"],
					message: "Domain and application layers must not depend on the Stream Deck SDK (design §8).",
				},
				{
					group: ["**/providers/**", "**/adapters/**", "**/presentation/**", "**/actions/**"],
					allowTypeImports: true,
					message:
						"Import the port as a type and inject the implementation; do not depend on it at runtime (design §8).",
				},
			],
		},
	],
};

export default tseslint.config(
	{
		ignores: [
			"node_modules/**",
			"com.agentdeck.streamdeck-plus.sdPlugin/bin/**",
			"src/generated/codex/**",
			"coverage/**",
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
			"no-console": "warn",
		},
	},
	{
		files: ["src/domain/**/*.ts", "src/application/**/*.ts"],
		rules: layerBoundary,
	},
	{
		// Build scripts, test helpers and the fake app-server run under Node directly.
		files: ["**/*.mjs", "**/*.js", "scripts/**", "tests/**"],
		languageOptions: { globals: { ...globals.node } },
		rules: { "no-console": "off" },
	},
	{
		// The property inspector runs in the Stream Deck's embedded browser.
		files: ["com.agentdeck.streamdeck-plus.sdPlugin/ui/**/*.js"],
		languageOptions: { globals: { ...globals.browser }, sourceType: "script" },
	},
	prettier,
);
