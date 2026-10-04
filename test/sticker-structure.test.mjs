import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { designCss, loadDesignFonts, resolveDesignPath, shareImageSvg } from "../scripts/design/build.mjs";
import { loadStructure } from "../scripts/design/validate.mjs";
import { RELAYER_ICON_NAMES, relayerIconFamily } from "../desktop/renderer/src/product-workspace/icons.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
// Custom properties the renderer sets from JavaScript at runtime.
const RUNTIME_PROPERTIES = new Set([
  "graph-zoom", "graph-share", "interaction-graph-available-height", "interaction-graph-available-width",
  "context-draft-send-warning-bottom", "context-draft-send-warning-right",
]);

describe("Sticker structure", () => {
  it("generates every role and family colour for both themes from the default design", async () => {
    const config = JSON.parse(await readFile(await resolveDesignPath(""), "utf8"));
    const css = designCss(config, "designs/test.json");
    const [dark, light] = [/^:root\{([^}]*)\}/m, /^:root\[data-theme="light"\]\{([^}]*)\}/m].map((pattern) => pattern.exec(css)[1]);
    for (const [role, value] of Object.entries(config.palette.roles)) {
      expect(dark).toContain(`--${role}:${value.dark}`);
      expect(light).toContain(`--${role}:${value.light}`);
    }
    expect(light).toContain(`--family-f1:${config.palette.families.f1.light};--family-f1-icon:${config.palette.families.f1.lightIcon}`);
    expect([dark.endsWith("color-scheme:dark"), light.endsWith("color-scheme:light")]).toEqual([true, true]);
  });

  it("defines every custom property the renderer stylesheet reads", async () => {
    const styles = await read("desktop/renderer/styles.css");
    const config = JSON.parse(await readFile(await resolveDesignPath(""), "utf8"));
    const fonts = await loadDesignFonts(await loadStructure(config.structure));
    const defined = new Set([...`${styles}${designCss(config, "designs/test.json", fonts)}`.matchAll(/--([a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const undefinedProperties = [...new Set([...styles.matchAll(/var\(--([a-z0-9-]+)/g)].map((match) => match[1]))]
      .filter((name) => !defined.has(name) && !RUNTIME_PROPERTIES.has(name));
    expect(undefinedProperties).toEqual([]);
    expect(styles.startsWith('@import url("./design/design.css");\n')).toBe(true);
  });

  it("bundles the structure's licensed fonts with verified bytes and same-origin @font-face rules", async () => {
    const config = JSON.parse(await readFile(await resolveDesignPath(""), "utf8"));
    const fonts = await loadDesignFonts(await loadStructure(config.structure));
    expect(fonts.map(({ role, font }) => [role, font.family, font.license])).toEqual([
      ["ui", "Figtree", "OFL-1.1"], ["display", "Bricolage Grotesque", "OFL-1.1"], ["mono", "DM Mono", "OFL-1.1"],
    ]);
    for (const { files } of fonts) expect(files.some((file) => file.path.endsWith("/OFL.txt"))).toBe(true);
    const css = designCss(config, "designs/test.json", fonts);
    expect(css).toContain('@font-face{font-family:"Figtree";src:url("./fonts/figtree/figtree-latin-wght-normal.woff2") format("woff2")');
    expect(css).toContain('--font-mono:"DM Mono",ui-monospace');
    expect(css).not.toMatch(/url\(["']?(https?:)?\/\//);
  });

  it("draws the share link preview image from the design's dark roles, families and fonts (PD-14)", async () => {
    const config = JSON.parse(await readFile(await resolveDesignPath(""), "utf8"));
    const svg = shareImageSvg(config, await loadDesignFonts(await loadStructure(config.structure)));
    const { roles, families } = config.palette;
    for (const colour of [roles.bg.dark, roles.text.dark, roles["accent-text"].dark, roles.edge.dark, families.f3.dark, families.f6.dark]) {
      expect(svg).toContain(`"${colour}"`);
    }
    expect(svg).toContain(`font-family="Figtree,-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"`);
    // The drawn wordmark replaces the typeset title.
    expect(svg).toContain('<g role="img" aria-label="Relayer"');
    expect(svg).not.toContain(">Relayer</text>");
    expect([...svg.matchAll(/#[0-9A-Fa-f]{6}/g)].every(([colour]) => JSON.stringify(config.palette).includes(colour))).toBe(true);
    const aliased = structuredClone(config);
    aliased.palette.roles["accent-text"].dark = "var(--accent-solid)";
    expect(shareImageSvg(aliased)).toContain(`fill="${roles["accent-solid"].dark}" font-family`);
  });

  it("preserves legacy families and presents expanded symbols neutrally", async () => {
    const catalog = JSON.parse(await read("docs/icon-catalog.json"));
    const counts = {};
    for (const name of catalog.legacyNames) counts[relayerIconFamily(name)] = (counts[relayerIconFamily(name)] ?? 0) + 1;
    // Design brief Appendix A (13 / 18 / 23 / 21 / 8 / 10 coloured, 23 neutral) plus the temporary everyday icons (#613).
    expect(counts).toEqual({ f1: 13, f2: 18, f3: 26, f4: 26, f5: 12, f6: 10, neutral: 23 });
    const expanded = RELAYER_ICON_NAMES.filter(name => !catalog.legacyNames.includes(name));
    // The upstream file-pen alias resolves to existing file-edit and retains its family.
    expect(expanded.filter(name => relayerIconFamily(name) !== "neutral")).toEqual(["file-pen"]);
    expect(relayerIconFamily("file-pen")).toBe("f1");
    expect(expanded).toHaveLength(catalog.icons.length - catalog.legacyNames.length);
    expect([relayerIconFamily("MessagesSquare"), relayerIconFamily("messagessquare"), relayerIconFamily("not-an-icon"), relayerIconFamily(undefined)])
      .toEqual(["f5", "f5", "neutral", "neutral"]);
  });
});
