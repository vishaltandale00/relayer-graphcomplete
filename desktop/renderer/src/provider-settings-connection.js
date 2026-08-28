import { createProviderConnectionCancellationState } from "./provider-onboarding-model.js";

export function createProviderSettingsConnectionController({
  providers,
  createConnectionId = () => crypto.randomUUID().toLowerCase(),
  wait = () => new Promise((resolve) => setTimeout(resolve, 750)),
  onPending = () => {},
}) {
  const ownership = createProviderConnectionCancellationState();

  return Object.freeze({
    current: ownership.current,
    async connect(payload) {
      const requestId = createConnectionId();
      if (!ownership.begin(requestId)) return Object.freeze({ status: "ignored" });
      let ownedConnectionId = requestId;
      try {
        let result = await providers.connect({ ...payload, connectionId: requestId });
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
