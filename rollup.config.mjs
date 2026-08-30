import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

const sdPlugin = "com.agentdeck.streamdeck-plus.sdPlugin";
const isWatching = !!process.env.ROLLUP_WATCH;

/**
 * Shared plugin list; both bundles compile the same sources the same way.
 * @param {boolean} watchManifest
 * @returns {import('rollup').Plugin[]}
 */
function plugins(watchManifest) {
	return [
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
 *   `statusline.js` Claude Code executes this as its status-line command, which
 *                   is how Claude usage reaches the plugin (design §10).
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
			file: `${sdPlugin}/bin/statusline.js`,
			format: "es",
			sourcemap: isWatching,
		},
		plugins: plugins(false),
		external: [],
	},
];
