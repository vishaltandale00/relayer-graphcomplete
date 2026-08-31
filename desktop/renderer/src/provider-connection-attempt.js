import { createProviderConnectionCancellationState } from "./provider-onboarding-model.js";

export async function handleProviderConnectionDialogCancel({
  event,
  controller,
  closeDialog,
  showStatus,
}) {
  if (!controller?.current()) return Object.freeze({ closeAllowed: true, result: null });
  event.preventDefault();
  try {
    const result = await controller.close();
    if (result.cancelled) {
      closeDialog();
      return Object.freeze({ closeAllowed: true, result });
    }
    if (result.error) {
      showStatus("Relayer could not confirm cancellation. The provider connection is still running.", "error");
      return Object.freeze({ closeAllowed: false, result });
    }
    showStatus("Provider connection is finishing and can no longer be cancelled.", "");
    return Object.freeze({ closeAllowed: false, result });
  } catch (error) {
    showStatus("Relayer could not confirm cancellation. The provider connection is still running.", "error");
    return Object.freeze({ closeAllowed: false, error });
  }
}

export function bindProviderConnectionDialogCancellation({ dialog, controller, showStatus }) {
  dialog.addEventListener("cancel", (event) => {
    void handleProviderConnectionDialogCancel({
      event,
      controller,
      closeDialog: () => dialog.close(),
      showStatus,
    });
  });
}

export function createProviderConnectionAttemptController({
  providers,
  createConnectionId = () => crypto.randomUUID().toLowerCase(),
  wait = () => new Promise((resolve) => setTimeout(resolve, 750)),
  onPending = () => {},
  onStateChange = () => {},
}) {
  const ownership = createProviderConnectionCancellationState();
  const idle = Object.freeze({ phase: "idle", intent: null, connectionId: null });
  let state = idle;

  const transition = (phase, intent = state.intent, connectionId = state.connectionId) => {
    state = phase === "idle"
      ? idle
      : Object.freeze({ phase, intent, connectionId });
    onStateChange(state);
  };

  async function settle(requestId, intent, start) {
    if (ownership.current() !== null) return Object.freeze({ status: "ignored" });
    if (!ownership.begin(requestId)) return Object.freeze({ status: "ignored" });
    transition("starting", intent, requestId);
    let ownedConnectionId = requestId;
    try {
      let result = await start();
      if (!ownership.matches(ownedConnectionId)) return Object.freeze({ status: "abandoned" });
      if (result.status === "pending") {
        if (!ownership.transition(ownedConnectionId, result.connectionId)) {
          return Object.freeze({ status: "abandoned" });
        }
        ownedConnectionId = result.connectionId;
        transition("waiting_for_sign_in", intent, ownedConnectionId);
      }
      while (result.status === "pending" && ownership.matches(ownedConnectionId)) {
        onPending(result);
        await wait();
        if (!ownership.matches(ownedConnectionId)) return Object.freeze({ status: "abandoned" });
        result = await providers.completeConnection(ownedConnectionId);
      }
      if (!ownership.matches(ownedConnectionId)) return Object.freeze({ status: "abandoned" });
      return Object.freeze({ status: "settled", result });
    } finally {
      ownership.complete(ownedConnectionId);
      if (ownership.current() === null && state.phase !== "idle") transition("idle");
    }
  }

  return Object.freeze({
    current: ownership.current,
    state: () => state,
    connect(payload) {
      const requestId = createConnectionId();
      return settle(requestId, "connect", () => providers.connect({ ...payload, connectionId: requestId }));
    },
    reconnect(providerId) {
      const requestId = String(providerId || "");
      if (!requestId) return Promise.reject(new Error("Provider reconnect requires a provider definition id."));
      return settle(requestId, "reconnect", () => providers.reconnect(requestId));
    },
    async close() {
      const result = await ownership.cancel((connectionId) => providers.cancelConnection(connectionId));
      if (result.cancelled && ownership.current() === null && state.phase !== "idle") transition("idle");
      return result;
    },
  });
}
