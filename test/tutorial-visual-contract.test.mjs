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
  it("keeps the coach surface compact, connected, and legible across themes and layouts", async () => {
    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    const controller = await readFile(
      new URL("../desktop/renderer/src/onboarding-tutorial.js", import.meta.url),
      "utf8",
    );

    expect(styles, "dedicated tutorial surface color").toContain("--tutorial-surface:#17243a");
    expect(styles, "coachmark paints the tutorial surface").toContain("background:var(--tutorial-surface)");
    expect(styles, "legacy fixed coachmark removed").not.toContain(".tutorial-coachmark{position:fixed;z-index:90");
    expect(styles, "legacy raised background removed").not.toContain("background:var(--raised);box-shadow:0 24px");
    expect(styles, "compact heading hierarchy").toContain(".tutorial-coachmark h2{margin:0;font-size:14px;font-weight:700");
    expect(styles, "compact copy hierarchy").toContain(".tutorial-coachmark p{margin:7px 0 0;color:var(--tutorial-copy);font-size:12px;line-height:1.5}");
    expect(styles, "keyboard-sized buttons").toContain(".tutorial-coachmark button{min-width:72px;height:32px");
    expect(styles, "visible keyboard focus").toContain(".tutorial-coachmark button:focus-visible{outline:2px solid var(--tutorial-accent);outline-offset:2px");
    expect(styles, "complete-state layout").toContain(".tutorial-coachmark.tutorial-complete{width:250px;display:flex;align-items:center");

    expect(contrast("#f4f7fb", "#17243a"), "dark heading contrast").toBeGreaterThan(12);
    expect(contrast("#c5d4e8", "#17243a"), "dark copy contrast").toBeGreaterThan(9);
    expect(contrast("#17243a", "#edf4ff"), "light heading contrast").toBeGreaterThan(12);
    expect(contrast("#3f536e", "#edf4ff"), "light copy contrast").toBeGreaterThan(6);

    expect(styles, "highlighted target outline").toContain(".tutorial-target{outline:2px solid #80aef8!important;outline-offset:5px");
    expect(styles, "coach connector arrow").toContain(".tutorial-coachmark:before");
    expect(styles, "light-theme target highlight").toContain('html[data-theme="light"] .tutorial-target');
    expect(styles, "light-theme coach surface").toContain('html[data-theme="light"] .tutorial-coachmark{--tutorial-surface:#edf4ff');
    expect(styles, "narrow-layout coach width").toContain("@media(max-width:760px){.tutorial-coachmark{width:min(288px");
    expect(styles, "narrow-layout coach scrolling").toContain("max-height:calc(100vh - 20px);overflow:auto");
    expect(styles, "narrow-layout new thread centering").toContain(".new-thread-center{width:720px;max-width:calc(100% - 48px)}");
    expect(controller, "complete class toggled with state").toContain('element.classList.toggle("tutorial-complete", complete);');
  });
});
