import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

function luminance(hex) {
  const channels = hex.match(/[\da-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("tutorial coach-mark visual contract", () => {
  it("keeps a clear compact hierarchy and visible keyboard affordances", async () => {
    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");

    expect(styles).toContain("--tutorial-surface:#17243a");
    expect(styles).toContain("background:var(--tutorial-surface)");
    expect(styles).not.toContain(".tutorial-coachmark{position:fixed;z-index:90");
    expect(styles).not.toContain("background:var(--raised);box-shadow:0 24px");
    expect(styles).toContain(".tutorial-coachmark h2{margin:0;font-size:14px;font-weight:700");
    expect(styles).toContain(".tutorial-coachmark p{margin:7px 0 0;color:var(--tutorial-copy);font-size:12px;line-height:1.5}");
    expect(styles).toContain(".tutorial-coachmark button{min-width:72px;height:32px");
    expect(styles).toContain(".tutorial-coachmark button:focus-visible{outline:2px solid var(--tutorial-accent);outline-offset:2px");
    expect(styles).toContain(".tutorial-coachmark.tutorial-complete{width:250px;display:flex;align-items:center");

    expect(contrast("#f4f7fb", "#17243a")).toBeGreaterThan(12);
    expect(contrast("#c5d4e8", "#17243a")).toBeGreaterThan(9);
    expect(contrast("#17243a", "#edf4ff")).toBeGreaterThan(12);
    expect(contrast("#3f536e", "#edf4ff")).toBeGreaterThan(6);
  });

  it("connects the highlighted target and coach surface across dark, light, and narrow layouts", async () => {
    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    const controller = await readFile(
      new URL("../desktop/renderer/src/onboarding-tutorial.js", import.meta.url),
      "utf8",
    );

    expect(styles).toContain(".tutorial-target{outline:2px solid #80aef8!important;outline-offset:5px");
    expect(styles).toContain(".tutorial-coachmark:before");
    expect(styles).toContain('html[data-theme="light"] .tutorial-target');
    expect(styles).toContain('html[data-theme="light"] .tutorial-coachmark{--tutorial-surface:#edf4ff');
    expect(styles).toContain("@media(max-width:760px){.tutorial-coachmark{width:min(288px");
    expect(styles).toContain("max-height:calc(100vh - 20px);overflow:auto");
    expect(styles).toContain(".new-thread-center{width:720px;max-width:calc(100% - 48px)}");
    expect(controller).toContain('element.classList.toggle("tutorial-complete", complete);');
  });
});
