// PROTOTYPE — throwaway (issue #684). Floating switcher (⌥← ⌥→, URL-stable).
// The chat-input placement is decided (C); the bar now compares Annotate options (Q3).
export const VARIANTS = [
  ["A", "Docked chat input"],
  ["B", "Floating chat bubble"],
  ["C", "Leave full-screen to send"],
  ["D", "Review drawer"],
];

export const ANNOTATE_MODES = [
  ["a", "Panel drops from the icon"],
  ["b", "Popover at the bottom"],
  ["c", "Mark an area first"],
  ["d", "Note field inside the toolbar"],
  ["e", "Thin note bar at the bottom"],
  ["f", "Click to drop a pin"],
];

export function currentVariant() {
  const value = new URLSearchParams(location.search).get("variant");
  return VARIANTS.some(([key]) => key === value) ? value : "C";
}

export function currentAnnotateMode() {
  const value = new URLSearchParams(location.search).get("annotate");
  return ANNOTATE_MODES.some(([key]) => key === value) ? value : "a";
}

export function mountSwitcher({ variant, annotateMode, surface }) {
  const index = ANNOTATE_MODES.findIndex(([key]) => key === annotateMode);
  const go = (delta) => {
    const next = ANNOTATE_MODES[(index + delta + ANNOTATE_MODES.length) % ANNOTATE_MODES.length][0];
    const url = new URL(location.href);
    url.searchParams.set("annotate", next);
    url.searchParams.set("variant", variant);
    // Keep the open artifact so the options can be compared on the same content.
    const open = window.__prototype?.viewer.state()?.layerId;
    if (open) url.searchParams.set("open", open); else url.searchParams.delete("open");
    location.replace(url);
  };
  const bar = document.createElement("div");
  bar.className = "proto-switcher";
  bar.innerHTML = `<button type="button" aria-label="Previous option">←</button>
    <span>Annotate <b>${annotateMode}</b> · ${ANNOTATE_MODES[index][1]}<i class="proto-sub"> · chat ${variant}${surface !== "product" ? ` · ${surface}` : ""}</i></span>
    <button type="button" aria-label="Next option">→</button>
    <a href="/artifact-viewer-matrix.prototype.html" title="Case matrix">Matrix ↗</a>`;
  const [previous, next] = bar.querySelectorAll("button");
  previous.onclick = () => go(-1);
  next.onclick = () => go(1);
  addEventListener("keydown", (event) => {
    if (event.target.closest?.("input, textarea, [contenteditable]")) return;
    if (event.key === "ArrowLeft" && event.altKey) go(-1);
    if (event.key === "ArrowRight" && event.altKey) go(1);
  });
  document.body.append(bar);
}
