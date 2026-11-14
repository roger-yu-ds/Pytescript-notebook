// Generates media/ring.woff: nine glyphs (U+E000–U+E008) showing a ring filled
// 0/8 … 8/8, used by the context indicator in the status bar.
//   node scripts/make-ring-font.mjs
import { SVGIcons2SVGFontStream } from "svgicons2svgfont";
import svg2ttf from "svg2ttf";
import ttf2woff from "ttf2woff";
import { Readable } from "node:stream";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const S = 1000; // glyph size
const C = S / 2;

/** A circle as a closed path; clockwise or counter-clockwise. */
function circle(r, cw) {
  const sweep = cw ? 1 : 0;
  return `M ${C} ${C - r} A ${r} ${r} 0 1 ${sweep} ${C} ${C + r} A ${r} ${r} 0 1 ${sweep} ${C} ${C - r} Z`;
}

/** An annulus sector from 12 o'clock, clockwise, covering `frac` of the circle. */
function arc(r1, r2, frac) {
  if (frac >= 1) return circle(r2, true) + " " + circle(r1, false);
  const a = frac * 2 * Math.PI;
  const pt = (r, t) => [C + r * Math.sin(t), C - r * Math.cos(t)];
  const large = frac > 0.5 ? 1 : 0;
  const [ox, oy] = pt(r2, a);
  const [ix, iy] = pt(r1, a);
  return `M ${C} ${C - r2} A ${r2} ${r2} 0 ${large} 1 ${ox} ${oy} L ${ix} ${iy} A ${r1} ${r1} 0 ${large} 0 ${C} ${C - r1} Z`;
}

const glyph = (k) => {
  const thin = circle(400, true) + " " + circle(340, false); // the track
  const fill = k > 0 ? arc(270, 470, k / 8) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><path fill-rule="nonzero" d="${thin} ${fill}"/></svg>`;
};

const font = new SVGIcons2SVGFontStream({ fontName: "polyglot-ring", fontHeight: S, normalize: false, log: () => {} });
let svgFont = "";
font.on("data", (d) => (svgFont += d));
const done = new Promise((r) => font.on("end", r));
for (let k = 0; k <= 8; k++) {
  const s = Readable.from([glyph(k)]);
  s.metadata = { unicode: [String.fromCodePoint(0xe000 + k)], name: `ring-${k}` };
  font.write(s);
}
font.end();
await done;
const ttf = svg2ttf(svgFont, {});
const woff = ttf2woff(new Uint8Array(ttf.buffer));
writeFileSync(path.join(here, "../media/ring.woff"), Buffer.from(woff.buffer ?? woff));
console.log("wrote media/ring.woff");
