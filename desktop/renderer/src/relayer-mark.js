// The Relayer mark is three slashes at a fixed pitch. Spread (0 → 1) they become the
// wordmark RE / A \ ƎЯ: the first slash grows a foot and becomes the L, the middle slash
// splits into the A, the last slash gains an arm and becomes the Y, and the R and E pairs
// swing out of the outer slashes. Every letter is drawn upright in strokes at the slash
// weight and the whole word is sheared once, so every stem and cut is parallel.
// Design A of the 2026-10-03 logo decision; the metrics are Bricolage Grotesque 700 at 100px.
const FONT = { cap: 66, xHeight: 52.5, ascender: 69.5, descender: 15.4, stem: 15 };
const LEAN_DEGREES = 18;
const STACK_GAP = 1; // gap between slashes, in stem widths
const WORD_GAP = 0.9; // gap between letters, in stem widths
const Y_JUNCTION = 0.8; // where the y arm lands, as a fraction of the descender
const Y_ARM_RAISE = 0.24; // the y arm starts this far above the x-height
const TILE_FILL = 0.72; // the mark spans this much of its tile
const TILE_RADIUS = 0.22;
export const LOCKUP_HEIGHT = 24;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => { const u = clamp01((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - ((-2 * u + 2) ** 3) / 2);
const n = (value) => String(Math.round(value * 100) / 100);

function geometry() {
  const k = Math.tan((LEAN_DEGREES * Math.PI) / 180);
  const s = FONT.stem, p = s * (1 + STACK_GAP), eg = s * WORD_GAP;
  const yTop = -FONT.cap, yBot = 4, h = yBot - yTop, ym = (yTop + yBot) / 2, sb = s * 0.9;
  const c0 = [0, 1, 2].map((i) => s / 2 + i * p), Ws = 2 * p + s + k * h;
  const Rb = 0.63 * h, Rw = Rb + 3, Ew = 0.6 * h, Em = 0.52 * h, Lf = 0.56 * h, yMid = yTop + 0.5 * h, r = (yMid - (yTop + s / 2)) / 2;
  const oxE1 = Rw + eg, c1 = oxE1 + Ew + eg + s / 2, cA = c1 - s / 2 + Lf + eg + s / 2;
  const legR = (y) => cA + s / 2 + 2 * k * (y - yTop);
  const yJ = -FONT.descender * Y_JUNCTION;
  const yT = Math.max(yTop, -FONT.xHeight * (1 + Y_ARM_RAISE)), run = 2 * k * (yJ - yT);
  const egAY = eg * 1.8, c2 = Math.max(legR(yT) + egAY + s / 2 + run, legR(yJ) + egAY + s / 2);
  const oxE2 = c2 + s / 2 + eg, oxR2 = oxE2 + Ew + eg;
  const visL = -k * yBot, visR = oxR2 + Rw - k * yTop;
  const tile = Ws / TILE_FILL;
  return {
    k, s, sb, yTop, yBot, h, ym, c0, Ws, Rb, Rw, Ew, Em, Lf, yMid, r, oxR1: 0, oxE1, c1, cA, c2, yJ, yT, run, oxE2, oxR2,
    // The mark's frame is its tile; the wordmark's frame is the word's full extents.
    markBox: { x: Ws / 2 - tile / 2, y: ym - tile / 2, width: tile, height: tile },
    wordBox: { x: visL, y: -FONT.ascender - 5, width: visR - visL, height: FONT.ascender + FONT.descender + 10 },
  };
}

const rect = (x, y, w, h, attrs = "") => (w > 0 ? `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="currentColor"${attrs}/>` : "");
const polygon = (points) => `<polygon points="${points.map(([x, y]) => `${n(x)},${n(y)}`).join(" ")}" fill="currentColor"/>`;
const rotate = (points, [px, py], angle) => {
  const c = Math.cos(angle), sn = Math.sin(angle);
  return points.map(([x, y]) => [px + x * c - y * sn, py + x * sn + y * c]);
};

function letterR(G, ox) {
  const { s, yTop, yBot, h, Rb, yMid, r } = G, y1 = yTop + s / 2, xr = ox + Rb - s / 2, x0 = ox + s / 2;
  const bowl = `M${n(x0)},${n(y1)}H${n(xr - r)}A${n(r)},${n(r)} 0 0 1 ${n(xr)},${n(y1 + r)}A${n(r)},${n(r)} 0 0 1 ${n(xr - r)},${n(yMid)}H${n(x0)}`;
  const xl0 = ox + 0.4 * Rb, xl1 = ox + Rb + 3 - s;
  return rect(ox, yTop, s, h)
    + `<path d="${bowl}" fill="none" stroke="currentColor" stroke-width="${n(s)}" stroke-linecap="butt"/>`
    + polygon([[xl0, yMid], [xl0 + s, yMid], [xl1 + s, yBot], [xl1, yBot]]);
}

function letterE(G, ox, mirror) {
  const { s, sb, yTop, yBot, h, Ew, Em, yMid } = G;
  return rect(mirror ? ox + Ew - s : ox, yTop, s, h)
    + [[yTop, Ew], [yMid - sb / 2, Em], [yBot - sb, Ew]].map(([y, L]) => rect(mirror ? ox + Ew - L : ox, y, L, sb)).join("");
}

// Renders the mark at spread t: 0 is the three-slash mark in its tile, 1 is the wordmark.
// `tile` and `glyphs` are SVG fragments; callers colour them (CSS classes in the app,
// fill and color attributes in standalone files).
export function renderMark(t = 0) {
  const G = geometry(), { k, s, sb, yTop, yBot, h, Lf, yJ, yT, run } = G;
  const box = {
    x: lerp(G.markBox.x, G.wordBox.x, t), y: lerp(G.markBox.y, G.wordBox.y, t),
    width: lerp(G.markBox.width, G.wordBox.width, t), height: lerp(G.markBox.height, G.wordBox.height, t),
  };
  const cL = lerp(G.c0[0], G.c1, t), cA = lerp(G.c0[1], G.cA, t), cY = lerp(G.c0[2], G.c2, t);
  let glyphs = [cL, cA, cY].map((c) => rect(c - s / 2, yTop, s, h)).join("");
  // The middle letters finish first: the L foot, A and y arm are complete by 70% of the spread.
  const ef = ease(smoothstep(0.2, 0.7, t));
  if (ef > 0.02) glyphs += polygon(rotate([[-1.5 * ef, -sb], [Lf - s, -sb], [Lf - s, 0], [-1.5 * ef, 0]], [cL + s / 2, yBot], -(Math.PI / 2) * (1 - ef)));
  const e = ease(smoothstep(0.05, 0.6, t)), off = 2 * k * h * e;
  if (e > 0.02) glyphs += polygon([[cA - s / 2, yTop], [cA + s / 2, yTop], [cA + s / 2 + off, yBot], [cA - s / 2 + off, yBot]]);
  const yc = yBot - 0.38 * h, xL = cA + s / 2 - 1.5, xR = cA - s / 2 + 2 * k * (yc + sb / 2 - yTop) + 1.5;
  glyphs += rect(xL, yc - sb / 2, (xR - xL) * ease(smoothstep(0.3, 0.72, t)), sb);
  const ea = ease(smoothstep(0.2, 0.7, t)), armAngle = Math.atan2(run, yJ - yT);
  if (ea > 0.02) glyphs += polygon(rotate([[-s / 2, 0], [s / 2, 0], [-run + s / 2, yT - yJ], [-run - s / 2, yT - yJ]], [cY, yJ], armAngle * (1 - ea)));
  // R and E swing out of the L slash like a door hinged on it; ƎЯ swing out of the Y slash the other way.
  // The hinge scale multiplies a whole half-word, so it keeps four decimals.
  const sx = Math.round(ease(smoothstep(0.25, 1, t)) * 1e4) / 1e4;
  if (sx > 0.02) {
    glyphs += `<g transform="translate(${n(cL)},0) scale(${sx},1) translate(${n(-G.c1)},0)">${letterR(G, G.oxR1)}${letterE(G, G.oxE1, false)}</g>`;
    glyphs += `<g transform="translate(${n(cY)},0) scale(${sx},1) translate(${n(-G.c2)},0)">${letterE(G, G.oxE2, true)}`
      + `<g transform="translate(${n(2 * G.oxR2 + G.Rw)},0) scale(-1,1)">${letterR(G, G.oxR2)}</g></g>`;
    // The outer letters open faster than their slashes travel, so late in the spread they reach
    // past the frame interpolated between tile and word; widen it so the SVG never clips them.
    const left = Math.min(box.x, cL - sx * G.c1 - k * yBot);
    const right = Math.max(box.x + box.width, cY + sx * (G.oxR2 + G.Rw - G.c2) - k * yTop);
    box.x = left;
    box.width = right - left;
  }
  const tileSide = box.height;
  return {
    box,
    tile: `<rect class="brand-tile" x="${n(box.x)}" y="${n(box.y)}" width="${n(tileSide)}" height="${n(tileSide)}" rx="${n(tileSide * TILE_RADIUS)}"/>`,
    glyphs: `<g class="brand-ink" transform="matrix(1,0,${(-k).toFixed(4)},1,0,0)">${glyphs}</g>`,
    // How far the tile has dissolved into the bare word; CSS derives the tile and ink colours from it.
    spread: smoothstep(0, 0.35, t),
  };
}

const viewBox = ({ x, y, width, height }) => `${n(x)} ${n(y)} ${n(width)} ${n(height)}`;

// The standalone mark: the app icon, favicon and share attribution image, and (as white on
// black) the luminance mask that gives the in-app tiles their shape.
export function markSvg({ tile, ink }) {
  const mark = renderMark(0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox(mark.box)}" role="img" aria-label="Relayer">`
    + `<g fill="${tile}">${mark.tile}</g><g color="${ink}">${mark.glyphs}</g></svg>\n`;
}

// The wordmark as an SVG fragment, placed by baseline and cap height inside a larger drawing.
export function wordmark({ ink, x, baseline, capHeight }) {
  const G = geometry(), scale = capHeight / G.h, mark = renderMark(1);
  return `<g role="img" aria-label="Relayer" color="${ink}" transform="translate(${n(x)},${n(baseline)}) scale(${n(scale)}) translate(${n(-G.wordBox.x)},${n(-G.yBot)})">${mark.glyphs}</g>`;
}

// Drives one inline SVG between the mark (spread 0) and the wordmark (spread 1).
// `reducedMotion` may be a boolean or a function read at each transition, so an OS preference
// changed while the app runs takes effect on the next hover.
export function createBrandLockup(svg, {
  height = LOCKUP_HEIGHT,
  reducedMotion = false,
  duration = 700,
  now = () => performance.now(),
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
} = {}) {
  let spread = 0, frame = null;
  const draw = (t) => {
    spread = t;
    const mark = renderMark(t);
    svg.setAttribute("viewBox", viewBox(mark.box));
    svg.setAttribute("width", n((height * mark.box.width) / mark.box.height));
    svg.setAttribute("height", String(height));
    svg.style.setProperty("--brand-spread", mark.spread.toFixed(3));
    svg.innerHTML = mark.tile + mark.glyphs;
  };
  draw(0);
  return {
    get spread() { return spread; },
    setSpread(target, { animate = !(typeof reducedMotion === "function" ? reducedMotion() : reducedMotion) } = {}) {
      if (frame !== null) { cancelFrame(frame); frame = null; }
      if (!animate || target === spread) return draw(target);
      const from = spread, start = now();
      const step = (time) => {
        const u = clamp01((time - start) / duration);
        draw(lerp(from, target, ease(u)));
        frame = u < 1 ? requestFrame(step) : null;
      };
      frame = requestFrame(step);
    },
  };
}

// Hovering the lockup spreads it into the wordmark; leaving folds it back to the mark.
export function spreadOnHover(element, lockup, canSpread = () => true) {
  element.addEventListener("pointerenter", () => { if (canSpread()) lockup.setSpread(1); });
  element.addEventListener("pointerleave", () => lockup.setSpread(0));
}
