import { createProviderConnectionCancellationState } from "./provider-onboarding-model.js";

export function createProviderSettingsConnectionController({
  providers,
  createConnectionId = () => crypto.randomUUID().toLowerCase(),
  wait = () => new Promise((resolve) => setTimeout(resolve, 750)),
  onPending = () => {},
}) {
  const ownership = createProviderConnectionCancellationState();

  async function settle(requestId, start) {
    if (ownership.current() !== null) return Object.freeze({ status: "ignored" });
    if (!ownership.begin(requestId)) return Object.freeze({ status: "ignored" });
    let ownedConnectionId = requestId;
    try {
      let result = await start();
      if (!ownership.matches(ownedConnectionId)) return Object.freeze({ status: "abandoned" });
      if (result.status === "pending") {
        if (!ownership.transition(ownedConnectionId, result.connectionId)) {
          return Object.freeze({ status: "abandoned" });
        }
        ownedConnectionId = result.connectionId;
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
    }
  }

  return Object.freeze({
    current: ownership.current,
    connect(payload) {
      const requestId = createConnectionId();
      return settle(requestId, () => providers.connect({ ...payload, connectionId: requestId }));
    },
    reconnect(providerId) {
      const requestId = String(providerId || "");
      if (!requestId) return Promise.reject(new Error("Provider reconnect requires a provider definition id."));
      return settle(requestId, () => providers.reconnect(requestId));
    },
    close() {
      const connectionId = ownership.current();
      if (!connectionId) return false;
      ownership.complete(connectionId);
      void providers.cancelConnection(connectionId).catch(() => {});
      return true;
    },
  });
}
