/**
 * Generates the plugin's static PNG assets.
 *
 * Runtime key images are SVG data URIs produced by `key-renderer.ts`; these PNGs
 * only cover the manifest slots (plugin icon, category icon, action icons and the
 * default state image). Generating them keeps the repository free of opaque
 * binaries and makes the palette a single source of truth.
 *
 * Usage: npm run icons
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "com.agentdeck.streamdeck-plus.sdPlugin", "imgs");

const PALETTE = {
	background: [0x10, 0x11, 0x14, 0xff],
	surface: [0x1b, 0x1d, 0x22, 0xff],
	text: [0xf2, 0xf3, 0xf5, 0xff],
	muted: [0x9a, 0xa0, 0xa6, 0xff],
	accent: [0x3d, 0x8b, 0xfd, 0xff],
	ok: [0x2f, 0xbf, 0x71, 0xff],
	warn: [0xe0, 0xa8, 0x00, 0xff],
	danger: [0xe5, 0x48, 0x4d, 0xff],
	transparent: [0, 0, 0, 0],
};

// ------------------------------------------------------------------ PNG output

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) {
		c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * (stride + 1)] = 0; // filter type: none
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ----------------------------------------------------------------- rasterising

class Canvas {
	constructor(size) {
		this.size = size;
		this.data = Buffer.alloc(size * size * 4);
	}

	blend(x, y, [r, g, b, a], coverage) {
		if (x < 0 || y < 0 || x >= this.size || y >= this.size) {
			return;
		}
		const alpha = (a / 255) * coverage;
		if (alpha <= 0) {
			return;
		}
		const i = (y * this.size + x) * 4;
		const dstA = this.data[i + 3] / 255;
		const outA = alpha + dstA * (1 - alpha);
		for (let c = 0; c < 3; c += 1) {
			const src = [r, g, b][c];
			const dst = this.data[i + c];
			this.data[i + c] = outA === 0 ? 0 : Math.round((src * alpha + dst * dstA * (1 - alpha)) / outA);
		}
		this.data[i + 3] = Math.round(outA * 255);
	}

	/** Rounded rectangle in unit coordinates (0–1), anti-aliased by supersampling. */
	roundedRect(x0, y0, w, h, radius, color) {
		const s = this.size;
		const left = x0 * s;
		const top = y0 * s;
		const right = left + w * s;
		const bottom = top + h * s;
		const r = radius * s;

		for (let y = Math.floor(top); y < Math.ceil(bottom); y += 1) {
			for (let x = Math.floor(left); x < Math.ceil(right); x += 1) {
				let hits = 0;
				for (let sy = 0; sy < 3; sy += 1) {
					for (let sx = 0; sx < 3; sx += 1) {
						const px = x + (sx + 0.5) / 3;
						const py = y + (sy + 0.5) / 3;
						if (insideRoundedRect(px, py, left, top, right, bottom, r)) {
							hits += 1;
						}
					}
				}
				if (hits > 0) {
					this.blend(x, y, color, hits / 9);
				}
			}
		}
	}

	circle(cx, cy, radius, color) {
		const s = this.size;
		this.roundedRect(cx - radius, cy - radius, radius * 2, radius * 2, radius, color);
		void s;
	}

	toPng() {
		return encodePng(this.size, this.size, this.data);
	}
}

function insideRoundedRect(px, py, left, top, right, bottom, r) {
	if (px < left || px > right || py < top || py > bottom) {
		return false;
	}
	const cx = Math.min(Math.max(px, left + r), right - r);
	const cy = Math.min(Math.max(py, top + r), bottom - r);
	const dx = px - cx;
	const dy = py - cy;
	return dx * dx + dy * dy <= r * r;
}

// --------------------------------------------------------------------- glyphs

const GLYPHS = {
	plugin(canvas) {
		canvas.roundedRect(0, 0, 1, 1, 0.22, PALETTE.background);
		canvas.roundedRect(0.18, 0.22, 0.64, 0.1, 0.05, PALETTE.accent);
		canvas.roundedRect(0.18, 0.45, 0.44, 0.1, 0.05, PALETTE.ok);
		canvas.roundedRect(0.18, 0.68, 0.28, 0.1, 0.05, PALETTE.warn);
	},
	category(canvas) {
		canvas.roundedRect(0.06, 0.06, 0.88, 0.88, 0.2, PALETTE.accent);
		canvas.circle(0.5, 0.5, 0.18, PALETTE.background);
	},
	agent(canvas) {
		canvas.circle(0.5, 0.5, 0.34, PALETTE.ok);
	},
	stop(canvas) {
		canvas.roundedRect(0.2, 0.2, 0.6, 0.6, 0.1, PALETTE.danger);
	},
	approve(canvas) {
		// A ring with a tick: the ring is the hold, the tick is the answer.
		canvas.circle(0.5, 0.5, 0.38, PALETTE.ok);
		canvas.circle(0.5, 0.5, 0.29, PALETTE.background);
		canvas.roundedRect(0.3, 0.48, 0.16, 0.08, 0.04, PALETTE.ok);
		canvas.roundedRect(0.44, 0.34, 0.08, 0.24, 0.04, PALETTE.ok);
	},
	deny(canvas) {
		canvas.circle(0.5, 0.5, 0.38, PALETTE.danger);
		canvas.circle(0.5, 0.5, 0.29, PALETTE.background);
		canvas.roundedRect(0.28, 0.46, 0.44, 0.08, 0.04, PALETTE.danger);
	},
	usage(canvas) {
		canvas.roundedRect(0.16, 0.54, 0.16, 0.3, 0.05, PALETTE.ok);
		canvas.roundedRect(0.42, 0.36, 0.16, 0.48, 0.05, PALETTE.warn);
		canvas.roundedRect(0.68, 0.2, 0.16, 0.64, 0.05, PALETTE.danger);
	},
	git(canvas) {
		canvas.roundedRect(0.28, 0.2, 0.1, 0.6, 0.05, PALETTE.muted);
		canvas.circle(0.33, 0.24, 0.12, PALETTE.accent);
		canvas.circle(0.33, 0.76, 0.12, PALETTE.accent);
		canvas.circle(0.7, 0.4, 0.12, PALETTE.ok);
		canvas.roundedRect(0.33, 0.44, 0.34, 0.08, 0.04, PALETTE.muted);
	},
	project(canvas) {
		canvas.roundedRect(0.14, 0.26, 0.72, 0.52, 0.08, PALETTE.accent);
		canvas.roundedRect(0.14, 0.18, 0.34, 0.14, 0.05, PALETTE.accent);
		canvas.roundedRect(0.24, 0.44, 0.52, 0.08, 0.04, PALETTE.background);
		canvas.roundedRect(0.24, 0.58, 0.34, 0.08, 0.04, PALETTE.background);
	},
	launcher(canvas) {
		canvas.circle(0.5, 0.5, 0.36, PALETTE.surface);
		canvas.roundedRect(0.46, 0.18, 0.08, 0.42, 0.04, PALETTE.ok);
		canvas.roundedRect(0.32, 0.3, 0.08, 0.2, 0.04, PALETTE.ok);
		canvas.roundedRect(0.6, 0.3, 0.08, 0.2, 0.04, PALETTE.ok);
	},
	dashboard(canvas) {
		for (let i = 0; i < 4; i += 1) {
			canvas.roundedRect(0.08 + i * 0.22, 0.34, 0.16, 0.32, 0.05, i === 1 ? PALETTE.ok : PALETTE.muted);
		}
	},
};

/** `key` variants sit on the dark key background; icon variants are transparent. */
function render(glyph, size, withBackground) {
	const canvas = new Canvas(size);
	if (withBackground) {
		canvas.roundedRect(0, 0, 1, 1, 0.12, PALETTE.background);
	}
	GLYPHS[glyph](canvas);
	return canvas.toPng();
}

function write(relativePath, buffer) {
	const target = join(OUT, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, buffer);
	return target;
}

const ACTIONS = ["agent", "stop", "approve", "deny", "usage", "git", "project", "launcher", "dashboard"];

write("plugin/icon.png", render("plugin", 288, false));
write("plugin/icon@2x.png", render("plugin", 576, false));
write("plugin/category.png", render("category", 28, false));
write("plugin/category@2x.png", render("category", 56, false));

for (const name of ACTIONS) {
	write(`actions/${name}/icon.png`, render(name, 20, false));
	write(`actions/${name}/icon@2x.png`, render(name, 40, false));
	write(`actions/${name}/key.png`, render(name, 72, true));
	write(`actions/${name}/key@2x.png`, render(name, 144, true));
}

console.log(`Generated ${(ACTIONS.length * 4 + 4).toString()} icons in ${OUT}`);
