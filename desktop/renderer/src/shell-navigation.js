const NARROW_QUERY = "(max-width: 760px)";

export function createShellNavigation({
  trigger,
  panel,
  settingsButton,
  accountButton,
  enabled = true,
  body = document.body,
  windowObject = window,
  mediaQuery = windowObject.matchMedia(NARROW_QUERY),
}) {
  const settingsItem = panel.querySelector("#shellNavigationSettings");
  const accountItem = panel.querySelector("#shellNavigationAccount");

  const available = () => enabled && (body.classList.contains("sidebar-collapsed") || mediaQuery.matches);
  const close = ({ returnFocus = false } = {}) => {
    panel.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
    if (!returnFocus) return;
    if (!trigger.classList.contains("hidden")) {
      trigger.focus();
    } else if (settingsButton && !settingsButton.classList.contains("hidden")) {
      settingsButton.focus();
    } else {
      document.querySelector('[data-settings-tab][aria-selected="true"]')?.focus();
    }
  };
  const sync = () => {
    const visible = available();
    trigger.classList.toggle("hidden", !visible);
    if (!visible) close({ returnFocus: !panel.classList.contains("hidden") });
  };
  const onTrigger = () => {
    if (!available()) return;
    const opening = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !opening);
    trigger.setAttribute("aria-expanded", String(opening));
    if (opening) settingsItem.focus();
  };
  const onPanelClick = (event) => {
    const item = event.target.closest("button");
    if (!item) return;
    close({ returnFocus: true });
    if (item === settingsItem) settingsButton.click();
    if (item === accountItem) accountButton.click();
  };
  const onDocumentClick = (event) => {
    if (!panel.classList.contains("hidden")
      && !panel.contains(event.target)
      && !trigger.contains(event.target)) close();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape" && !panel.classList.contains("hidden")) {
      event.preventDefault();
      close({ returnFocus: true });
    }
  };
  const onMediaChange = () => sync();

  trigger.addEventListener("click", onTrigger);
  panel.addEventListener("click", onPanelClick);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeyDown);
  mediaQuery.addEventListener?.("change", onMediaChange);
  sync();

  return {
    sync,
    close,
    dispose() {
      trigger.removeEventListener("click", onTrigger);
      panel.removeEventListener("click", onPanelClick);
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
      mediaQuery.removeEventListener?.("change", onMediaChange);
      close();
    },
  };
}
