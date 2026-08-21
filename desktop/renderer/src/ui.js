export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let toastTimer;

export function applyAppearance(value) {
  const appearance = value === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = appearance;
  localStorage.setItem("relayerAppearance", appearance);
  $("#appearanceSelect").value = appearance;
}

export function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

export function escapeHtmlAttribute(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function toast(message) {
  clearTimeout(toastTimer);
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  toastTimer = setTimeout(() => element.classList.add("hidden"), 2_600);
}

export function threadTitle(prompt) {
  const firstLine = prompt.split("\n").find((line) => line.trim())?.trim() || "New thread";
  return firstLine.length > 54 ? `${firstLine.slice(0, 53)}…` : firstLine;
}
