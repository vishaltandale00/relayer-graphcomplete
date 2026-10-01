import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { contrast, dE } from "../scripts/design/color.mjs";
import { importPalette } from "../scripts/design/import-palette.mjs";
import { checkStructure, loadStructure, validate, validateDesign } from "../scripts/design/validate.mjs";

const run = promisify(execFile);
const hPath = "designs/h-sticker-cocoa.json";
const prototype = new URL("../docs/design/visual-redesign/sources/gen2/H/", import.meta.url);
const readH = async () => JSON.parse(await readFile(new URL(`../${hPath}`, import.meta.url), "utf8"));

// One changed copy of H per failure class.
function variant(config, change) {
  const copy = structuredClone(config);
  change(copy);
  return copy;
}

describe("design config validation", () => {
  it("accepts H with check-by-check the same results as the preserved prototype checker", async () => {
    // The preserved checker calls process.exit(), which can truncate piped
    // console output. A regular file makes its writes synchronous without
    // changing the historical reference or weakening the 282-row comparison.
    const directory = await mkdtemp(join(tmpdir(), "design-reference-"));
    let stdout;
    try {
      const output = await open(join(directory, "reference.md"), "w");
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ["contrast.mjs", "--md"], {
            cwd: fileURLToPath(prototype), stdio: ["ignore", output.fd, "pipe"],
          });
          let errorOutput = "";
          child.stderr.on("data", (chunk) => { errorOutput += chunk; });
          child.once("error", reject);
          child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`Prototype checker failed (${code ?? signal}): ${errorOutput}`)));
        });
      } finally { await output.close(); }
      stdout = await readFile(join(directory, "reference.md"), "utf8");
    } finally { await rm(directory, { recursive: true, force: true }); }
    const row = /^\| (light|dark) \| .*? \| `([^`]+)` \| `([^`]+)` \| ([^|]+) \| [^|]+ \| ([^|]+) \|(.*)$/;
    const expected = stdout.split("\n").map((line) => row.exec(line)).filter(Boolean).map(([, mode, a, b, value, floor]) => ({
      key: `${mode}|${a}|${b}|${value.trim()}`, floor: floor.trim() === "—" ? 0 : Number(floor),
    }));
    const { errors, warnings, checks } = await validate(await readH());
    expect([errors, warnings]).toEqual([[], []]);
    const actual = checks.map((check) => ({
      key: `${check.mode}|${check.a}|${check.b}|${check.value.toFixed(check.type === "contrast" ? 2 : 1)}`, floor: check.floor,
    }));
    const byKey = (list) => [...list].sort((x, y) => x.key.localeCompare(y.key));
    expect(expected).toHaveLength(282);
    expect(byKey(actual).map((check) => check.key)).toEqual(byKey(expected).map((check) => check.key));
    // Running may share interaction's hue (ADR 0013), so only these floors moved from the prototype.
    const unmatched = expected.map((check) => `${check.key}|${check.floor}`);
    const moved = actual.filter((check) => {
      const index = unmatched.indexOf(`${check.key}|${check.floor}`);
      if (index >= 0) unmatched.splice(index, 1);
      return index < 0;
    }).map((check) => check.key.split("|").slice(0, 3).join(" "));
    expect(moved.map((key) => key.replace(/ #[0-9A-F]{6}/g, "")).sort()).toEqual([
      "dark accent-soft-bg running-soft-bg", "dark accent-text running-text", "dark running selection-ring",
      "light accent-soft-bg running-soft-bg", "light accent-text running-text", "light running selection-ring",
    ]);
  });

  it("computes colour maths that match published reference values, independently of the prototype", () => {
    // WCAG 2.2: black on white is 21:1, #777777 on white is 4.48:1; OKLab lightness spans 0 to 1 (dE x100).
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#FFFFFF").toFixed(2)).toBe("4.48");
    expect(contrast("#FFFFFF", "#FFFFFF")).toBe(1);
    expect(dE("#000000", "#FFFFFF")).toBeCloseTo(100, 1);
    expect(dE("#725345", "#725345")).toBe(0);
  });

  it("imports H through the real command line and keeps lab configs out of git", async () => {
    const { stdout } = await run(process.execPath, [
      "scripts/design/import-palette.mjs", "docs/design/visual-redesign/sources/gen2/H/tokens.mjs", "--structure", "sticker", "--name", "H · Sticker × Cocoa",
    ]);
    expect(JSON.parse(stdout)).toEqual(await readH());
    await expect(run("git", ["check-ignore", "designs/lab/x.json"])).resolves.toBeTruthy();
    await expect(run("git", ["ls-files", "--error-unmatch", "designs/lab/.gitkeep"])).resolves.toBeTruthy();
  });

  it("keeps the committed H config in step with its prototype token source", async () => {
    const { TOKENS, FAMILIES } = await import(new URL("tokens.mjs", prototype).href);
    const imported = await importPalette({ tokens: TOKENS, families: FAMILIES, structure: await loadStructure("sticker"), name: "H · Sticker × Cocoa" });
    expect(imported).toEqual(await readH());
  });

  it("names every schema and integrity failure", async () => {
    const h = await readH();
    const structure = await loadStructure("sticker");
    const codes = (config) => validateDesign(config, structure).errors.map((error) => error.code);
    expect(codes(variant(h, (c) => { c.format = 2; }))).toEqual(["schema.format"]);
    expect(codes(variant(h, (c) => { delete c.name; }))).toEqual(["schema.name"]);
    expect(codes(variant(h, (c) => { c.status = "shipped"; }))).toEqual(["schema.unknown-field"]);
    expect(codes(variant(h, (c) => { c.palette.roles.text.light = "#12345"; }))).toEqual(["schema.colour"]);
    expect(codes(variant(h, (c) => { c.palette.families.f1.icons = []; }))).toEqual(["schema.family"]);
    expect(codes(variant(h, (c) => { delete c.palette.roles.running; }))).toEqual(["integrity.missing-role"]);
    expect(codes(variant(h, (c) => { c.palette.roles.glow = { light: "#FFFFFF", dark: "#000000" }; }))).toEqual(["integrity.unknown-role"]);
    expect(codes(variant(h, (c) => { delete c.palette.families.f6; }))).toEqual(["integrity.families"]);
    expect(codes(variant(h, (c) => { c.overrides = { "node.height": 40 }; }))).toEqual(["integrity.override"]);
    expect(codes(variant(h, (c) => { c.palette.roles.edge.dark = "var(--glow)"; }))).toEqual(["integrity.alias-target"]);
    expect(codes(variant(h, (c) => { c.palette.roles.edge.dark = "var(--edge)"; }))).toEqual(["integrity.alias-cycle"]);
    expect(codes(variant(h, (c) => { c.palette.roles.text.light = "rgba(25,27,25,.9)"; }))).toEqual(["integrity.translucent"]);
    expect(codes(variant(h, (c) => { c.palette.roles.scrim.light = "rgba(999,0,0,.5)"; }))).toEqual(["schema.colour"]);
    expect(codes(variant(h, (c) => { c.palette.roles.edge = { light: "#747874" }; }))).toEqual(["schema.role"]);
    expect(codes(variant(h, (c) => { c.palette = { roles: {} }; }))).toEqual(["schema.palette"]);
    expect(codes(variant(h, (c) => { c.overrides = []; }))).toEqual(["schema.overrides"]);
    expect(validateDesign(h, null).errors.map((error) => error.code)).toEqual(["integrity.structure"]);
  });

  it("checks the structure file so a typo there cannot silently drop a check", async () => {
    const h = await readH();
    const structure = await loadStructure("sticker");
    expect(checkStructure(structure)).toEqual([]);
    const broken = variant(structure, (s) => {
      s.pairs[0].fg = "txet";
      s.pairs[1].kind = "huge";
      s.distinct[0].b = "scrim";
      s.floors.text = null;
    });
    expect(checkStructure(broken).map((error) => error.message)).toEqual([
      'sticker: pair names unknown role "txet".',
      'sticker: pair names translucent role "scrim", which has no single contrast.',
      'sticker: pair "primary text" has unknown kind "huge".',
      'sticker: floor "text" must be a finite number of at least 0.',
    ]);
    expect(validateDesign(h, broken).errors.every((error) => error.code === "structure.contract")).toBe(true);
  });

  it("lets running share interaction's colour but never merges two other meanings", async () => {
    const h = await readH();
    const structure = await loadStructure("sticker");
    const codes = (config) => validateDesign(config, structure).errors.map((error) => error.code);
    expect(codes(variant(h, (c) => { c.palette.roles["running-text"].light = "var(--accent-text)"; }))).toEqual([]);
    expect(codes(variant(h, (c) => { c.palette.roles["danger-text"].light = "var(--running-text)"; }))).toEqual(["integrity.alias-state"]);
    expect(codes(variant(h, (c) => { c.palette.roles["accent-text"].dark = "var(--accepted-mark)"; }))).toEqual(["integrity.alias-state"]);
    expect(codes(variant(h, (c) => { c.palette.roles["danger-text"].dark = "var(--text-muted)"; }))).toEqual(["integrity.alias-state"]);
    expect(codes(variant(h, (c) => { c.palette.roles["selection-ring"].dark = "var(--running)"; }))).toEqual(["integrity.alias-state"]);
    expect(codes(variant(h, (c) => { c.palette.roles["text-muted"].light = "var(--draft-text)"; }))).toEqual(["integrity.alias-state"]);
    expect(codes(variant(h, (c) => { c.palette.roles["text-faint"].light = "var(--text-muted)"; }))).toEqual([]);
  });

  it("reports a failed floor as a warning, not an error, until the PRD adopts the floors", async () => {
    const low = variant(await readH(), (c) => { c.palette.roles["text-muted"].light = "#C8CCC8"; });
    const { errors, warnings } = await validate(low);
    expect(errors).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(new Set(warnings.map((warning) => warning.code))).toEqual(new Set(["floor.contrast"]));
    const merged = await validate(variant(await readH(), (c) => { c.palette.roles["warning-solid"].dark = c.palette.roles["danger-solid"].dark; }));
    expect(merged.errors).toEqual([]);
    expect(merged.warnings.map((warning) => warning.code)).toEqual(["floor.distinct"]);
  });

  it("exits non-zero from the command line only for errors", async () => {
    const cli = (path) => run(process.execPath, ["scripts/design/validate.mjs", path]).then(() => 0, (error) => error.code);
    expect(await cli(hPath)).toBe(0);
    expect(await cli("package.json")).toBe(1);
  });
});
