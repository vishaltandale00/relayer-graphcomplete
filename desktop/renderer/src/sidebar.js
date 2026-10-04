import { spreadOnHover } from "./relayer-mark.js";

// The brand lockup rests on the mark and spreads on hover; the icon rail has no room for the
// word, so it ignores hover.
export function initializeSidebar({ body, toggle, mediaQuery, lockup, brand }) {
  if (lockup && brand) spreadOnHover(brand, lockup, () => !body.classList.contains("sidebar-collapsed"));
  const setCollapsed = (collapsed) => {
    body.classList.toggle("sidebar-collapsed", collapsed);
    lockup?.setSpread(0, { animate: false }); // the rail snaps, so the word must not overhang it
    const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };

  let narrowCollapseApplied = mediaQuery.matches;
  setCollapsed(narrowCollapseApplied || body.classList.contains("sidebar-collapsed"));
  toggle.addEventListener("click", () => {
    setCollapsed(!body.classList.contains("sidebar-collapsed"));
  });
  mediaQuery.addEventListener("change", (event) => {
    if (event.matches && !narrowCollapseApplied) {
      setCollapsed(true);
      narrowCollapseApplied = true;
    } else if (!event.matches) {
      narrowCollapseApplied = false;
    }
  });
  return { setCollapsed };
}
