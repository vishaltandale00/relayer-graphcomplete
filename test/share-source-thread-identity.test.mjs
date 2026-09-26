import { describe, expect, it, vi } from "vitest";

import { createShareSourceThreadIdentity } from "../desktop/main/services/share-source-thread-identity.mjs";

describe("share source-thread identity", () => {
  it("persists one installation identity and never exposes a bare local thread id", async () => {
    let value = {};
    const settings = {
      read: vi.fn(async () => structuredClone(value)),
      update: vi.fn(async (mutate) => { value = await mutate(structuredClone(value)); return value; }),
    };
    const first = createShareSourceThreadIdentity({
      settings,
      createInstallationId: () => "11111111-1111-4111-8111-111111111111",
    });
    await expect(first(7)).resolves.toBe("installation:11111111-1111-4111-8111-111111111111:thread:7");

    const reopened = createShareSourceThreadIdentity({
      settings,
      createInstallationId: () => "22222222-2222-4222-8222-222222222222",
    });
    await expect(reopened(7)).resolves.toBe("installation:11111111-1111-4111-8111-111111111111:thread:7");
    expect(settings.update).toHaveBeenCalledOnce();
  });

  it("rejects invalid thread ids and malformed stored installation identities", async () => {
    const valid = createShareSourceThreadIdentity({
      settings: { read: async () => ({}), update: async (mutate) => mutate({}) },
      createInstallationId: () => "11111111-1111-4111-8111-111111111111",
    });
    await expect(valid(0)).rejects.toThrow(/positive thread ID/);
    const malformed = createShareSourceThreadIdentity({
      settings: { read: async () => ({ shareInstallationId: "../../private" }), update: vi.fn() },
    });
    await expect(malformed(7)).rejects.toThrow(/installation identity/);
  });
});
