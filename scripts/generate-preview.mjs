/**
 * Renders the documentation images in `docs/images/`.
 *
 * The preview module lives in `src/`, so it is bundled with the same rollup +
 * TypeScript pipeline the plugin uses and then executed. That keeps the images
 * honest: they are produced by the shipped renderers and the shipped touch-strip
 * layout, not by a hand-drawn mockup that can quietly go out of date.
 *
 * Usage: npm run preview
 */

import typescript from "@rollup/plugin-typescript";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "docs", "images");
const TEMP_DIR = join(ROOT, "node_modules", ".agentdeck-preview");
const LAYOUT = join(ROOT, "com.agentdeck.streamdeck-plus.sdPlugin", "layouts", "segment.json");

const bundle = await rollup({
	input: join(ROOT, "src", "tools", "preview.ts"),
	plugins: [
		typescript({ tsconfig: join(ROOT, "tsconfig.build.json"), noEmitOnError: true, outDir: TEMP_DIR }),
	],
	logLevel: "warn",
});

const temp = join(TEMP_DIR, "preview.mjs");
mkdirSync(TEMP_DIR, { recursive: true });
await bundle.write({ file: temp, format: "es" });
await bundle.close();

const { renderDeckPreview, renderStatePreview } = await import(pathToFileURL(temp).href);
const layout = JSON.parse(readFileSync(LAYOUT, "utf8"));

mkdirSync(OUT_DIR, { recursive: true });
const images = [
	["deck.svg", renderDeckPreview(layout)],
	["states.svg", renderStatePreview()],
];

for (const [name, svg] of images) {
	const target = join(OUT_DIR, name);
	writeFileSync(target, `${svg}\n`);
	console.log(`Wrote ${target} (${(svg.length / 1024).toFixed(1)} kB)`);
}

rmSync(TEMP_DIR, { recursive: true, force: true });
