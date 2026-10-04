import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { LOCKUP_HEIGHT, createBrandLockup, markSvg, renderMark, spreadOnHover, wordmark } from "../desktop/renderer/src/relayer-mark.js";
import { relayerLogoAssets } from "../scripts/build-relayer-logo-assets.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const count = (markup, tag) => (markup.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
const slashStarts = (glyphs) => [...glyphs.matchAll(/<rect x="([^"]+)"/g)].slice(0, 3).map((match) => Number(match[1]));

function fakeSvg() {
  const attributes = new Map(), properties = new Map();
  return {
    attributes, properties, innerHTML: "",
    setAttribute: (name, value) => attributes.set(name, value),
    style: { setProperty: (name, value) => properties.set(name, value) },
  };
}

// A frame scheduler the tests advance by hand.
function fakeFrames() {
  let time = 0, handle = 0;
  const queue = new Map();
  return {
    now: () => time,
    requestFrame: (callback) => { queue.set(++handle, callback); return handle; },
    cancelFrame: (id) => queue.delete(id),
    advance(ms) { time += ms; const due = [...queue.values()]; queue.clear(); for (const callback of due) callback(time); },
    pending: () => queue.size,
  };
}

describe("Relayer mark", () => {
  it("collapsed, is three slashes at a fixed pitch inside a square tile", () => {
    const { box, tile, glyphs, spread } = renderMark(0);
    expect(box.width).toBeCloseTo(box.height);
    expect(spread).toBe(0);
    expect(count(glyphs, "rect")).toBe(3);
    expect(count(glyphs, "path") + count(glyphs, "polygon")).toBe(0);
    expect(slashStarts(glyphs)).toEqual([0, 30, 60]);
    expect(tile).toContain(`rx="${(box.height * 0.22).toFixed(2)}"`);
  });

  it("spread, is RE / A \\ ƎЯ with the slashes still on their lines", () => {
    const { box, glyphs, spread } = renderMark(1);
    expect(spread).toBe(1);
    expect(box.width / box.height).toBeGreaterThan(4);
    expect(count(glyphs, "path")).toBe(2); // the two R bowls
    expect(glyphs).toContain("scale(-1,1)"); // the final R is mirrored
    const [l, a, y] = slashStarts(glyphs);
    expect(l).toBeLessThan(a);
    expect(a).toBeLessThan(y);
  });

  it("widens monotonically, dissolves the tile by 35% and keeps the outer letters for last", () => {
    let previousWidth = 0, previousSpread = -1;
    for (const t of [0, 0.1, 0.25, 0.4, 0.6, 0.8, 1]) {
      const { box, spread } = renderMark(t);
      expect(box.width).toBeGreaterThan(previousWidth);
      expect(spread).toBeGreaterThanOrEqual(previousSpread);
      previousWidth = box.width;
      previousSpread = spread;
    }
    expect(renderMark(0.35).spread).toBe(1);
    expect(renderMark(0.2).glyphs).not.toContain("<path");
    expect(renderMark(0.2).glyphs).toContain("<polygon"); // the A's leg has started peeling away
  });

  it("keeps the outer letters inside the frame while they swing out", () => {
    for (const t of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1]) {
      const { box, glyphs } = renderMark(t);
      // Read the drawing back from the markup: shear, the two door-hinge transforms, the mirror and the stems.
      const k = -Number(/matrix\(1,0,(-?[\d.]+),1,0,0\)/.exec(glyphs)[1]);
      const [, , top, , tall] = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)"/.exec(glyphs).map(Number);
      const hinges = [...glyphs.matchAll(/translate\((-?[\d.]+),0\) scale\((-?[\d.]+),1\) translate\((-?[\d.]+),0\)/g)].map((m) => m.slice(1).map(Number));
      const [[xL, sL, offsetL], [xY, sY, offsetY]] = hinges;
      const mirror = Number(/translate\((-?[\d.]+),0\) scale\(-1,1\)/.exec(glyphs)[1]);
      const stemR2 = Number(/scale\(-1,1\)"><rect x="(-?[\d.]+)"/.exec(glyphs)[1]);
      const left = xL + sL * (0 + offsetL) - k * (top + tall); // the first R stem, at the bottom of the shear
      const right = xY + sY * (mirror - stemR2 + offsetY) - k * top; // the mirrored R stem, at the top of the shear
      expect(box.x, `t=${t} left`).toBeLessThanOrEqual(left + 0.05); // markup rounds to 0.01 units
      expect(box.x + box.width, `t=${t} right`).toBeGreaterThanOrEqual(right - 0.05);
    }
  });

  it("commits the icon and the tile mask exactly as the geometry renders them", async () => {
    const assets = await relayerLogoAssets();
    expect(Object.keys(assets)).toEqual(["relayer-logo.svg", "relayer-mark-mask.svg"]);
    for (const [name, svg] of Object.entries(assets)) expect(await read(`desktop/renderer/assets/${name}`)).toBe(svg);
    expect(assets["relayer-mark-mask.svg"]).toContain('<g fill="#fff">');
    expect(assets["relayer-mark-mask.svg"]).toContain('<g color="#000">');
    expect(markSvg({ tile: "#000", ink: "#fff" })).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]+" role="img" aria-label="Relayer">/);
  });

  it("places the wordmark by baseline and cap height without its tile", () => {
    const fragment = wordmark({ ink: "#ECEEEC", x: 120, baseline: 128, capHeight: 44 });
    expect(fragment).toContain('role="img" aria-label="Relayer" color="#ECEEEC"');
    expect(fragment).toContain("translate(120,128) scale(0.63)");
    expect(fragment).not.toContain("brand-tile");
  });
});

describe("brand lockup", () => {
  it("paints the mark at once and eases into the wordmark over the duration", () => {
    const svg = fakeSvg(), frames = fakeFrames();
    const lockup = createBrandLockup(svg, { duration: 700, ...frames });
    expect(svg.attributes.get("width")).toBe(String(LOCKUP_HEIGHT));
    expect(svg.attributes.get("height")).toBe(String(LOCKUP_HEIGHT));
    expect(svg.properties.get("--brand-spread")).toBe("0.000");
    expect(svg.innerHTML).toContain("brand-tile");

    lockup.setSpread(1);
    expect(frames.pending()).toBe(1);
    frames.advance(0);
    frames.advance(350);
    expect(lockup.spread).toBeGreaterThan(0.3);
    expect(lockup.spread).toBeLessThan(0.7);
    frames.advance(350);
    expect(lockup.spread).toBe(1);
    expect(frames.pending()).toBe(0);
    expect(Number(svg.attributes.get("width"))).toBeGreaterThan(4 * LOCKUP_HEIGHT);
    expect(svg.properties.get("--brand-spread")).toBe("1.000");
    expect(svg.innerHTML).toContain("brand-ink");
  });

  it("scales to the requested height, as the hero does", () => {
    const svg = fakeSvg();
    createBrandLockup(svg, { height: 40, reducedMotion: true }).setSpread(1);
    expect(svg.attributes.get("height")).toBe("40");
    expect(Number(svg.attributes.get("width"))).toBeGreaterThan(4 * 40);
  });

  it("spreads on hover and folds back on leave, unless spreading is disallowed", () => {
    const listeners = new Map(), spreads = [];
    let allowed = true;
    spreadOnHover({ addEventListener: (name, callback) => listeners.set(name, callback) }, { setSpread: (value) => spreads.push(value) }, () => allowed);
    listeners.get("pointerenter")();
    listeners.get("pointerleave")();
    allowed = false;
    listeners.get("pointerenter")();
    expect(spreads).toEqual([1, 0]);
  });

  it("retargets mid-flight and jumps under reduced motion", () => {
    const frames = fakeFrames();
    const lockup = createBrandLockup(fakeSvg(), { ...frames });
    lockup.setSpread(1);
    frames.advance(0);
    frames.advance(200);
    expect(lockup.spread).toBeGreaterThan(0);
    lockup.setSpread(0);
    expect(frames.pending()).toBe(1);
    frames.advance(0);
    frames.advance(700);
    expect(lockup.spread).toBe(0);
    expect(frames.pending()).toBe(0);

    const still = createBrandLockup(fakeSvg(), { reducedMotion: true, ...frames });
    still.setSpread(1);
    expect(still.spread).toBe(1);
    expect(frames.pending()).toBe(0);

    // A preference read per transition: the OS setting can change while the app runs.
    let reduce = false;
    const live = createBrandLockup(fakeSvg(), { reducedMotion: () => reduce, ...frames });
    live.setSpread(1);
    expect(frames.pending()).toBe(1);
    reduce = true;
    live.setSpread(0);
    expect(live.spread).toBe(0);
    expect(frames.pending()).toBe(0);
  });
});
