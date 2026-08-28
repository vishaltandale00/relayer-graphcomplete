import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeInputDraftApi } from "../desktop/renderer/src/node-input-drafts.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("node input draft renderer API", () => {
  it("uses the thread-scoped authenticated request grammar for get, commit, and detach", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ revision: 1, attachments: [] }),
    }));
    vi.stubGlobal("fetch", fetch);
    const api = createNodeInputDraftApi();
    const occurrence = {
      presentingInteractionNodeId: 41,
      presentingLayerId: 52,
      actionId: 63,
    };

    await api.get("thread / one");
    await api.commit("thread / one", occurrence, { selected: [{ key: "b", label: "Beta" }] }, 4);
    await api.detach("thread / one", occurrence, 5);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/threads/thread%20%2F%20one/input-draft",
      "/api/threads/thread%20%2F%20one/input-draft/attachments",
      "/api/threads/thread%20%2F%20one/input-draft/attachments/41/52/63?expectedRevision=5",
    ]);
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        occurrence,
        value: { selected: [{ key: "b", label: "Beta" }] },
        expectedRevision: 4,
      }),
    });
    expect(fetch.mock.calls[2][1]).toMatchObject({ method: "DELETE" });
    for (const [, options] of fetch.mock.calls) {
      expect(options.headers.Accept).toBe("application/json");
    }
  });
});
