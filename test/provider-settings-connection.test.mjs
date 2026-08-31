import { describe, expect, it, vi } from "vitest";

import { bindProviderConnectionDialogCancellation, createProviderConnectionAttemptController, handleProviderConnectionDialogCancel } from "../desktop/renderer/src/provider-connection-attempt.js";

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
  it("wires the native Settings dialog cancel boundary through confirmed cancellation", async () => {
    let cancelListener;
    const dialog = {
      addEventListener: vi.fn((type, listener) => {
        if (type === "cancel") cancelListener = listener;
      }),
      close: vi.fn(),
    };
    const cancellation = deferred();
    const controller = {
      current: () => "request-1",
      close: vi.fn(() => cancellation.promise),
    };
    const showStatus = vi.fn();
    bindProviderConnectionDialogCancellation({ dialog, controller, showStatus });
    const event = { preventDefault: vi.fn() };

    cancelListener(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(dialog.close).not.toHaveBeenCalled();
    cancellation.resolve({ cancelled: true, connectionId: "request-1" });
    await vi.waitFor(() => expect(dialog.close).toHaveBeenCalledOnce());
  });

  it.each([
    [{ cancelled: false, connectionId: "request-1" }, "Provider connection is finishing and can no longer be cancelled.", ""],
  ])("keeps the Settings dialog open when cancellation is not confirmed", async (
    cancellation,
    message,
    kind,
  ) => {
    const event = { preventDefault: vi.fn() };
    const closeDialog = vi.fn();
    const showStatus = vi.fn();
    const controller = {
      current: () => "request-1",
      close: vi.fn(async () => cancellation),
    };

    const outcome = await handleProviderConnectionDialogCancel({ event, controller, closeDialog, showStatus });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(closeDialog).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith(message, kind);
    expect(outcome.closeAllowed).toBe(false);
  });

  it("discloses an unconfirmed cancellation error returned by the real controller contract", async () => {
    const start = deferred();
    const providers = {
      connect: vi.fn(() => start.promise),
      completeConnection: vi.fn(),
      cancelConnection: vi.fn(async () => { throw new Error("IPC unavailable"); }),
    };
    const controller = createProviderConnectionAttemptController({
      providers,
      createConnectionId: () => "request-1",
    });
    const connecting = controller.connect({ adapterId: "openai-api" });
    const event = { preventDefault: vi.fn() };
    const closeDialog = vi.fn();
    const showStatus = vi.fn();

    const outcome = await handleProviderConnectionDialogCancel({ event, controller, closeDialog, showStatus });

    expect(outcome).toMatchObject({ closeAllowed: false, result: { cancelled: false, connectionId: "request-1" } });
    expect(outcome.result.error).toBeInstanceOf(Error);
    expect(closeDialog).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith(
      "Relayer could not confirm cancellation. The provider connection is still running.",
      "error",
    );
    start.resolve({ status: "connected", providerDefinition: { id: "openai-work" } });
    await expect(connecting).resolves.toMatchObject({ status: "settled" });
  });

  it("closes the Settings dialog only after backend cancellation is confirmed", async () => {
    const event = { preventDefault: vi.fn() };
    const closeDialog = vi.fn();
    const showStatus = vi.fn();
    const result = { cancelled: true, connectionId: "request-1" };

    await expect(handleProviderConnectionDialogCancel({
      event,
      controller: { current: () => "request-1", close: vi.fn(async () => result) },
      closeDialog,
      showStatus,
    })).resolves.toEqual({ closeAllowed: true, result });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(closeDialog).toHaveBeenCalledOnce();
    expect(showStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["connect", "connect", "request-1"],
    ["reconnect", "reconnect", "claude-work"],
  ])("exposes the shared starting and waiting-for-sign-in lifecycle for %s", async (
    operation,
    intent,
    connectionId,
  ) => {
    const start = deferred();
    const wait = deferred();
    const states = [];
    const providers = {
      connect: vi.fn(() => start.promise),
      reconnect: vi.fn(() => start.promise),
      completeConnection: vi.fn(async () => ({ status: "connected", providerDefinition: { id: "connected" } })),
      cancelConnection: vi.fn(async () => ({ cancelled: true })),
    };
    const controller = createProviderConnectionAttemptController({
      providers,
      createConnectionId: () => connectionId,
      wait: () => wait.promise,
      onStateChange: (state) => states.push(state),
    });

    const settling = operation === "connect"
      ? controller.connect({ adapterId: "claude-subscription" })
      : controller.reconnect(connectionId);
    expect(controller.state()).toEqual({ phase: "starting", intent, connectionId });

    start.resolve({ status: "pending", connectionId, login: { kind: "browser" } });
    await vi.waitFor(() => expect(controller.state()).toEqual({
      phase: "waiting_for_sign_in", intent, connectionId,
    }));
    wait.resolve();
    await expect(settling).resolves.toMatchObject({ status: "settled" });
    expect(controller.state()).toEqual({ phase: "idle", intent: null, connectionId: null });
    expect(states).toEqual([
      { phase: "starting", intent, connectionId },
      { phase: "waiting_for_sign_in", intent, connectionId },
      { phase: "idle", intent: null, connectionId: null },
    ]);
  });

  it("keeps the first Connect winner and continues through its managed-login id", async () => {
    const first = deferred();
    const providers = {
      connect: vi.fn(() => first.promise),
      completeConnection: vi.fn(async () => ({ status: "connected", providerDefinition: { id: "claude-work" } })),
      cancelConnection: vi.fn(async () => ({ cancelled: true })),
    };
    const onPending = vi.fn();
    const controller = createProviderConnectionAttemptController({
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
    const controller = createProviderConnectionAttemptController({
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
    const controller = createProviderConnectionAttemptController({
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
    const addController = createProviderConnectionAttemptController({
      providers,
      createConnectionId: () => "request-1",
    });
    const reconnectController = createProviderConnectionAttemptController({ providers });

    const adding = addController.connect({ adapterId: "openai-api" });
    const reconnecting = reconnectController.reconnect("claude-work");
    expect(addController.current()).toBe("request-1");
    expect(reconnectController.current()).toBe("claude-work");
    await expect(addController.close()).resolves.toMatchObject({ cancelled: true, connectionId: "request-1" });
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
    const controller = createProviderConnectionAttemptController({
      providers,
      createConnectionId: () => "request-1",
    });

    const connecting = controller.connect({ adapterId: "claude-subscription" });
    const closing = controller.close();
    expect(controller.current()).toBe("request-1");
    await expect(closing).resolves.toMatchObject({ cancelled: true, connectionId: "request-1" });
    expect(controller.current()).toBeNull();
    expect(providers.cancelConnection).toHaveBeenCalledWith("request-1");
    pending.resolve({ status: "connected", providerDefinition: { id: "claude-work" } });
    await expect(connecting).resolves.toEqual({ status: "abandoned" });
  });

  it("keeps ownership and settles when cancellation reaches an irreversible fresh connection", async () => {
    const start = deferred();
    const providers = {
      connect: vi.fn(() => start.promise),
      completeConnection: vi.fn(),
      cancelConnection: vi.fn(async () => ({ cancelled: false })),
    };
    const controller = createProviderConnectionAttemptController({
      providers,
      createConnectionId: () => "request-1",
    });

    const connecting = controller.connect({ adapterId: "openai-api" });
    await expect(controller.close()).resolves.toEqual({ cancelled: false, connectionId: "request-1" });
    expect(controller.current()).toBe("request-1");
    expect(controller.state()).toEqual({ phase: "starting", intent: "connect", connectionId: "request-1" });

    start.resolve({ status: "connected", providerDefinition: { id: "openai-work" } });
    await expect(connecting).resolves.toMatchObject({
      status: "settled",
      result: { status: "connected", providerDefinition: { id: "openai-work" } },
    });
    expect(controller.current()).toBeNull();
  });
});
