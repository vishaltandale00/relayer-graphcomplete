import { desktop } from "./state.js";
import { $ } from "./ui.js";

export function showApplication() {
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
}

export function showAuth(message) {
  $("#appShell").classList.add("hidden");
  $("#authScreen").classList.remove("hidden");
  $("#authStatus").textContent = message;
  $("#connectCodex").disabled = false;
  $("#connectCodex").textContent = "Connect";
}

export async function refreshAccount() {
  if (!desktop) {
    showApplication();
    return { status: "connected" };
  }
  const result = await desktop.account.read();
  if (result.status === "connected") {
    showApplication();
    const label = result.account?.email || "Codex connected";
    $("#settingsAccount").textContent = result.account?.planType
      ? `${label} · ${result.account.planType}`
      : label;
    return result;
  }
  showAuth(result.error || "");
  return result;
}

export async function connectCodex() {
  $("#connectCodex").disabled = true;
  $("#connectCodex").textContent = "Opening…";
  $("#authStatus").textContent = "Opening OpenAI login…";
  try {
    await desktop.account.login();
    $("#authStatus").textContent = "Complete login in your browser.";
    $("#connectCodex").textContent = "Open again";
    $("#connectCodex").disabled = false;
  } catch (error) {
    showAuth(error.message);
  }
}
