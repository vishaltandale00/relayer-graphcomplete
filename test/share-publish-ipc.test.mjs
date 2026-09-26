import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { registerSharePublishIpc } from "../desktop/main/ipc/register-ipc.mjs";

describe("share publication IPC authority", () => {
  it("passes only renderer input into Main and returns the coordinator's closed result", async () => {
    const handlers = new Map();
    const ipcMain = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)) };
    const coordinator = {
      preflight: vi.fn(async () => ({ status: "ready" })),
      create: vi.fn(async (input) => ({ status: "created", attemptReferenceId: "SHR-1", url: "https://share.test/t/1" })),
      retry: vi.fn(async (reference) => ({ status: "failed", attemptReferenceId: reference, code: "share_service_failed", retryable: true })),
    };

    registerSharePublishIpc({ ipcMain, coordinator });

    await expect(handlers.get("relayer:share-preflight")(null, { threadId: 7 }))
      .resolves.toEqual({ status: "ready" });
    expect(coordinator.preflight).toHaveBeenCalledWith({ threadId: 7 });
    await expect(handlers.get("relayer:share-create")(null, { threadId: 7, title: "Public" }))
      .resolves.toEqual({ status: "created", attemptReferenceId: "SHR-1", url: "https://share.test/t/1" });
    expect(coordinator.create).toHaveBeenCalledWith({ threadId: 7, title: "Public" });
    await handlers.get("relayer:share-retry")(null, { attemptReferenceId: "SHR-1" });
    expect(coordinator.retry).toHaveBeenCalledWith("SHR-1");
  });

  it("exposes only create/retry through preload with no bearer, bytes, or upload fields", async () => {
    const preload = await readFile(new URL("../desktop/preload/index.cjs", import.meta.url), "utf8");
    expect(preload).toContain('create: (threadId, title) => ipcRenderer.invoke("relayer:share-create", { threadId, title })');
    expect(preload).toContain('preflight: (threadId) => ipcRenderer.invoke("relayer:share-preflight", { threadId })');
    expect(preload).toContain('retry: (attemptReferenceId) => ipcRenderer.invoke("relayer:share-retry", { attemptReferenceId })');
    const exposedShare = preload.slice(preload.indexOf("share: {"), preload.indexOf("models: {"));
    expect(exposedShare).not.toMatch(/authorization|bearer|snapshotBytes|upload|signed/i);
  });
});
