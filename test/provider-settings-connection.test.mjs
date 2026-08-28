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
  it("keeps the first Connect winner and continues through its managed-login id", async () => {
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
    await expect(controller.connect({ adapterId: "claude-subscription", label: "Claude Work" }))
      .resolves.toEqual({ status: "ignored" });
    expect(providers.connect).toHaveBeenCalledTimes(1);
    expect(controller.current()).toBe("request-1");

    first.resolve({ status: "pending", connectionId: "authorization-1", login: { kind: "browser" } });
    await expect(winning).resolves.toEqual({
      status: "settled",
      result: { status: "connected", providerDefinition: { id: "claude-work" } },
    });
    expect(onPending).toHaveBeenCalledOnce();
    expect(providers.completeConnection).toHaveBeenCalledWith("authorization-1");
    expect(controller.current()).toBeNull();
  });

  it("releases ownership after errors so Settings can retry", async () => {
    const providers = {
      connect: vi.fn()
        .mockRejectedValueOnce(new Error("Authentication failed."))
        .mockResolvedValueOnce({ status: "connected", providerDefinition: { id: "openai-work" } }),
      completeConnection: vi.fn(),
      cancelConnection: vi.fn(async () => ({ cancelled: true })),
    };
    const controller = createProviderSettingsConnectionController({
      providers,
      createConnectionId: vi.fn().mockReturnValueOnce("request-1").mockReturnValueOnce("request-2"),
    });

    await expect(controller.connect({ adapterId: "openai-api" })).rejects.toThrow("Authentication failed.");
    expect(controller.current()).toBeNull();
    await expect(controller.connect({ adapterId: "openai-api" })).resolves.toMatchObject({ status: "settled" });
    expect(providers.connect).toHaveBeenCalledTimes(2);
  });

  it("claims a reconnect definition before IPC and ignores a duplicate click", async () => {
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
    expect(controller.current()).toBe("claude-work");
    await expect(controller.reconnect("claude-work")).resolves.toEqual({ status: "ignored" });
    expect(providers.reconnect).toHaveBeenCalledTimes(1);

    first.resolve({ status: "pending", connectionId: "authorization-1", login: { kind: "browser" } });
    await expect(winning).resolves.toEqual({
      status: "settled",
      result: { status: "connected", providerDefinition: { id: "claude-work" } },
    });
    expect(providers.completeConnection).toHaveBeenCalledWith("authorization-1");
    expect(controller.current()).toBeNull();
  });

  it("keeps Add Provider ownership isolated from reconnect ownership", async () => {
    const addPending = deferred();
    const reconnectPending = deferred();
    const providers = {
      connect: vi.fn(() => addPending.promise),
      reconnect: vi.fn(() => reconnectPending.promise),
      completeConnection: vi.fn(),
      cancelConnection: vi.fn(async () => ({ cancelled: true })),
    };
    const addController = createProviderSettingsConnectionController({
      providers,
      createConnectionId: () => "request-1",
    });
    const reconnectController = createProviderSettingsConnectionController({ providers });

    const adding = addController.connect({ adapterId: "openai-api" });
    const reconnecting = reconnectController.reconnect("claude-work");
    expect(addController.current()).toBe("request-1");
    expect(reconnectController.current()).toBe("claude-work");
    expect(addController.close()).toBe(true);
    expect(reconnectController.current()).toBe("claude-work");

    addPending.resolve({ status: "connected", providerDefinition: { id: "openai-work" } });
    reconnectPending.resolve({ status: "connected", providerDefinition: { id: "claude-work" } });
    await expect(adding).resolves.toEqual({ status: "abandoned" });
    await expect(reconnecting).resolves.toMatchObject({ status: "settled" });
    expect(providers.cancelConnection).toHaveBeenCalledWith("request-1");
  });

  it("releases and cancels the owned id when the Settings dialog closes", async () => {
    const pending = deferred();
    const providers = {
      connect: vi.fn(() => pending.promise),
      completeConnection: vi.fn(),
      cancelConnection: vi.fn(async () => ({ cancelled: true })),
    };
    const controller = createProviderSettingsConnectionController({
      providers,
      createConnectionId: () => "request-1",
    });

    const connecting = controller.connect({ adapterId: "claude-subscription" });
    expect(controller.close()).toBe(true);
    expect(controller.current()).toBeNull();
    expect(providers.cancelConnection).toHaveBeenCalledWith("request-1");
    pending.resolve({ status: "connected", providerDefinition: { id: "claude-work" } });
    await expect(connecting).resolves.toEqual({ status: "abandoned" });
  });
});
