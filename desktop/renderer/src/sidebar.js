export function initializeSidebar({ body, toggle, mediaQuery }) {
  const setCollapsed = (collapsed) => {
    body.classList.toggle("sidebar-collapsed", collapsed);
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
