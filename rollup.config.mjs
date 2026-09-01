import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { rmSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const sdPlugin = "com.agentdeck.streamdeck-plus.sdPlugin";
const isWatching = !!process.env.ROLLUP_WATCH;
/** Both bundles write into the same folder; only the first pass clears it. */
let cleaned = false;

/**
 * Shared plugin list; both bundles compile the same sources the same way.
 * @param {boolean} watchManifest
 * @returns {import('rollup').Plugin[]}
 */
function plugins(watchManifest) {
	return [
		{
			// `pack` ships whatever is in `bin/`, so a rename leaves the old bundle
			// behind and puts it in the installer. Renaming `statusline.js` to
			// `.mjs` did exactly that: the package carried a file that could not be
			// loaded, ready for anyone whose status line still pointed at it.
			name: "clean-output",
			buildStart: function () {
				if (!isWatching && !cleaned) {
					rmSync(`${sdPlugin}/bin`, { recursive: true, force: true });
					cleaned = true;
				}
			},
		},
		{
			name: "watch-externals",
			buildStart: function () {
				if (watchManifest) {
					this.addWatchFile(`${sdPlugin}/manifest.json`);
				}
			},
		},
		typescript({
			tsconfig: "./tsconfig.build.json",
			sourceMap: isWatching,
			mapRoot: isWatching ? "./" : undefined,
		}),
		nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
		commonjs(),
	];
}

/**
 * Two entry points:
 *   `plugin.js`     the Stream Deck host executes this with Node.
 *   `statusline.mjs` Claude Code executes this as its status-line command, which
 *                    is how Claude usage reaches the plugin (design §10). The
 *                    extension is load-bearing: an installed `.sdPlugin` folder
 *                    has no package.json, so a `.js` there is read as CommonJS.
 * @type {import('rollup').RollupOptions[]}
 */
export default [
	{
		input: "src/plugin.ts",
		output: {
			file: `${sdPlugin}/bin/plugin.js`,
			format: "es",
			sourcemap: isWatching,
			sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
				return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
			},
		},
		plugins: plugins(true),
		external: [],
	},
	{
		input: "src/statusline.ts",
		output: {
			file: `${sdPlugin}/bin/statusline.mjs`,
			format: "es",
			sourcemap: isWatching,
		},
		plugins: plugins(false),
		external: [],
	},
];
