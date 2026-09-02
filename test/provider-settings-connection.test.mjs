import { describe, expect, it, vi } from "vitest";

import { createProviderSettingsConnectionController } from "../desktop/renderer/src/provider-settings-connection.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("Provider Settings connection behavior", () => {
  it("keeps the first Connect winner, continues through its managed-login id, and releases ownership on error or close", async () => {
    const first = deferred();
    const providers = {
      connect: vi.fn(() => first.promise),
      completeConnection: vi.fn(async () => ({ status: "connected", providerDefinition: { id: "claude-work" } })),
      cancelConnection: vi.fn(async () => ({ cancelled: true })),
    };
    const onPending = vi.fn();
    const controller = createProviderSettingsConnectionController({
      providers,
      createConnectionId: vi.fn()
        .mockReturnValueOnce("request-1")
        .mockReturnValueOnce("request-2"),
      wait: async () => {},
      onPending,
    });

    const winning = controller.connect({ adapterId: "claude-subscription", label: "Claude Work" });
    await expect(
      controller.connect({ adapterId: "claude-subscription", label: "Claude Work" }),
      "a duplicate Connect is ignored",
    ).resolves.toEqual({ status: "ignored" });
    expect(providers.connect, "only the winner reaches IPC").toHaveBeenCalledTimes(1);
    expect(controller.current(), "the winning request id is owned").toBe("request-1");

    first.resolve({ status: "pending", connectionId: "authorization-1", login: { kind: "browser" } });
    await expect(winning, "the winner continues through its managed-login id").resolves.toEqual({
      status: "settled",
      result: { status: "connected", providerDefinition: { id: "claude-work" } },
    });
    expect(onPending, "pending managed login is announced once").toHaveBeenCalledOnce();
    expect(providers.completeConnection, "completion uses the managed-login connection id")
      .toHaveBeenCalledWith("authorization-1");
    expect(controller.current(), "ownership releases after settling").toBeNull();

    const retryProviders = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("Authentication failed."))
        .mockResolvedValueOnce({ status: "connected", providerDefinition: { id: "openai-work" } }),
      completeConnection: vi.fn(),
      cancelConnection: vi.fn(async () => ({ cancelled: true })),
    };
    const retryController = createProviderSettingsConnectionController({
      providers: retryProviders,
      createConnectionId: vi.fn().mockReturnValueOnce("request-1").mockReturnValueOnce("request-2"),
    });
    await expect(
      retryController.connect({ adapterId: "openai-api" }),
      "a failed Connect surfaces its error",
    ).rejects.toThrow("Authentication failed.");
    expect(retryController.current(), "errors release ownership").toBeNull();
    await expect(
      retryController.connect({ adapterId: "openai-api" }),
      "Settings can retry after an error",
    ).resolves.toMatchObject({ status: "settled" });
    expect(retryProviders.connect, "the retry reaches IPC").toHaveBeenCalledTimes(2);

    const closePending = deferred();
    const closeProviders = {
      connect: vi.fn(() => closePending.promise),
      completeConnection: vi.fn(),
      cancelConnection: vi.fn(async () => ({ cancelled: true })),
    };
    const closeController = createProviderSettingsConnectionController({
      providers: closeProviders,
      createConnectionId: () => "request-1",
    });
    const connecting = closeController.connect({ adapterId: "claude-subscription" });
    expect(closeController.close(), "closing the dialog releases the owned id").toBe(true);
    expect(closeController.current(), "close clears ownership").toBeNull();
    expect(closeProviders.cancelConnection, "close cancels the owned connection attempt")
      .toHaveBeenCalledWith("request-1");
    closePending.resolve({ status: "connected", providerDefinition: { id: "claude-work" } });
    await expect(connecting, "a late response after close is abandoned").resolves.toEqual({ status: "abandoned" });
  });

  it("isolates reconnect ownership from Add Provider ownership", async () => {
    const first = deferred();
    const providers = {
      connect: vi.fn(),
      reconnect: vi.fn(() => first.promise),
      completeConnection: vi.fn(async () => ({ status: "connected", providerDefinition: { id: "claude-work" } })),
      cancelConnection: vi.fn(async () => ({ cancelled: true })),
    };
    const controller = createProviderSettingsConnectionController({
      providers,
      wait: async () => {},
    });

    const winning = controller.reconnect("claude-work");
    expect(controller.current(), "reconnect claims the definition before IPC").toBe("claude-work");
    await expect(
      controller.reconnect("claude-work"),
      "a duplicate reconnect click is ignored",
    ).resolves.toEqual({ status: "ignored" });
    expect(providers.reconnect, "only the first reconnect reaches IPC").toHaveBeenCalledTimes(1);

    first.resolve({ status: "pending", connectionId: "authorization-1", login: { kind: "browser" } });
    await expect(winning, "reconnect continues through the managed-login id").resolves.toEqual({
      status: "settled",
      result: { status: "connected", providerDefinition: { id: "claude-work" } },
    });
    expect(providers.completeConnection, "reconnect completion uses the definition's connection id")
      .toHaveBeenCalledWith("authorization-1");
    expect(controller.current(), "reconnect ownership releases after settling").toBeNull();

    const addPending = deferred();
    const reconnectPending = deferred();
    const isolatedProviders = {
      connect: vi.fn(() => addPending.promise),
      reconnect: vi.fn(() => reconnectPending.promise),
      completeConnection: vi.fn(),
      cancelConnection: vi.fn(async () => ({ cancelled: true })),
    };
    const addController = createProviderSettingsConnectionController({
      providers: isolatedProviders,
      createConnectionId: () => "request-1",
    });
    const reconnectController = createProviderSettingsConnectionController({ providers: isolatedProviders });

    const adding = addController.connect({ adapterId: "openai-api" });
    const reconnecting = reconnectController.reconnect("claude-work");
    expect(addController.current(), "Add Provider owns its request id").toBe("request-1");
    expect(reconnectController.current(), "reconnect owns its definition id").toBe("claude-work");
    expect(addController.close(), "closing Add Provider releases only its own claim").toBe(true);
    expect(reconnectController.current(), "reconnect ownership survives Add Provider close").toBe("claude-work");

    addPending.resolve({ status: "connected", providerDefinition: { id: "openai-work" } });
    reconnectPending.resolve({ status: "connected", providerDefinition: { id: "claude-work" } });
    await expect(adding, "the closed Add Provider attempt is abandoned").resolves.toEqual({ status: "abandoned" });
    await expect(reconnecting, "the reconnect attempt still settles").resolves.toMatchObject({ status: "settled" });
    expect(isolatedProviders.cancelConnection, "only the Add Provider attempt is cancelled")
      .toHaveBeenCalledWith("request-1");
  });
});
