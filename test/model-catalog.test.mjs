import { describe, expect, it, vi } from "vitest";

import {
  ModelCatalogAdapter,
  sanitizeModelCatalogSnapshot,
  toProductCatalogSnapshot,
} from "../desktop/main/models/model-catalog-adapter.mjs";
import { CodexModelCatalogAdapter } from "../desktop/main/models/codex-model-catalog-adapter.mjs";
import { ModelCatalogService } from "../desktop/main/models/model-catalog-service.mjs";

function providerSnapshot({ providerId = "fake", models = [] } = {}) {
  return {
    provider: { id: providerId, label: "Fake", status: "available", unavailableReason: null },
    models: models.map((model) => ({
      id: model.id,
      executionModel: model.executionModel ?? model.id,
      label: model.label ?? model.id,
      description: "",
      visible: model.visible ?? true,
      availability: model.availability ?? "available",
      unavailableReason: model.unavailableReason ?? null,
      availabilityNotice: null,
      isDefault: false,
      replacementModelId: null,
      upgradeInfo: null,
      supportedEfforts: [],
      defaultEffort: null,
      inputModalities: ["text"],
      supportsPersonality: false,
      serviceTiers: [],
      defaultServiceTier: null,
    })),
    systemFamily: {
      id: providerId,
      label: "Fake",
      modelIds: models.filter((model) => model.visible ?? true).slice(0, 5).map(({ id }) => id),
    },
  };
}

class FakeModelCatalogAdapter extends ModelCatalogAdapter {
  constructor(discover, providerId = "fake") {
    super({ providerId, providerLabel: providerId });
    this.discoverSnapshot = discover;
  }

  discover(options) { return this.discoverSnapshot(options); }
}

describe("provider-neutral model catalog", () => {
  it("sanitizes provider-local identities and enforces the five-model system-family cap", () => {
    const snapshot = sanitizeModelCatalogSnapshot(providerSnapshot({
      models: [
        { id: "one" },
        { id: "two", availability: "unavailable", unavailableReason: "Not enabled for this account." },
      ],
    }));

    expect(snapshot.models[0]).toMatchObject({ providerId: "fake", id: "one", order: 0 });
    expect(snapshot.models[1]).toMatchObject({ availability: "unavailable", unavailableReason: "Not enabled for this account." });
    expect(Object.isFrozen(snapshot.models[0])).toBe(true);
    const oversized = providerSnapshot({
      models: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id })),
    });
    oversized.systemFamily.modelIds = ["a", "b", "c", "d", "e", "f"];
    expect(() => sanitizeModelCatalogSnapshot(oversized)).toThrow("cannot contain more than five");
    expect(() => sanitizeModelCatalogSnapshot(providerSnapshot({
      models: [{ id: "duplicate" }, { id: "duplicate" }],
    }))).toThrow("Duplicate provider model id");

    expect(toProductCatalogSnapshot(snapshot)).toMatchObject({
      providerId: "fake",
      label: "Fake",
      connected: true,
      models: [
        { id: "one", order: 0, available: true, providerDefault: false },
        {
          id: "two",
          order: 1,
          available: false,
          unavailableReason: { code: "provider_reported_unavailable", message: "Not enabled for this account." },
        },
      ],
      systemFamily: { key: "fake", name: "Fake", modelIds: ["one", "two"] },
    });
  });

  it("refreshes fake adapters for every required lifecycle trigger and publishes failures closed", async () => {
    const published = [];
    let call = 0;
    const adapter = new FakeModelCatalogAdapter(async () => {
      call += 1;
      if (call === 6) throw new Error("provider login expired");
      return providerSnapshot({ models: [{ id: `model-${call}` }] });
    });
    const service = new ModelCatalogService({
      adapters: [adapter],
      publishSnapshot: async (snapshot, context) => published.push({ snapshot, context }),
    });

    await service.startup();
    await service.providerChanged("fake");
    await service.settingsOpened();
    await service.explicitRefresh("fake");
    await service.beforeInference();
    const failed = await service.explicitRefresh();

    expect(published.map(({ context }) => context.reason)).toEqual([
      "startup", "provider-change", "settings-open", "explicit", "pre-inference", "explicit",
    ]);
    expect(published[0].snapshot).toMatchObject({
      providerId: "fake",
      connected: true,
      models: [{ id: "model-1", available: true }],
      systemFamily: { key: "fake", modelIds: ["model-1"] },
    });
    expect(failed[0]).toMatchObject({
      provider: { id: "fake", status: "unavailable", unavailableReason: "provider login expired" },
      models: [],
    });
  });

  it("reuses an in-flight catalog refresh for concurrent pre-inference callers", async () => {
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const published = [];
    let releaseDiscovery;
    const discoveryReleased = new Promise((resolve) => { releaseDiscovery = resolve; });
    const service = new ModelCatalogService({
      adapters: [new FakeModelCatalogAdapter(async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await discoveryReleased;
        active -= 1;
        return providerSnapshot({ models: [{ id: `model-${calls}` }] });
      })],
      publishSnapshot: async (snapshot, context) => published.push({ snapshot, context }),
    });

    const settingsRefresh = service.settingsOpened();
    await vi.waitFor(() => expect(calls).toBe(1));
    const firstInference = service.beforeInference();
    const secondInference = service.beforeInference();
    releaseDiscovery();
    await Promise.all([settingsRefresh, firstInference, secondInference]);

    expect(calls).toBe(1);
    expect(maximumActive).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0].context.reason).toBe("settings-open");
  });

  it("does not publish a pre-inference snapshot after its trusted request is aborted", async () => {
    let discoveryStarted;
    const started = new Promise((resolve) => { discoveryStarted = resolve; });
    const publishSnapshot = vi.fn();
    const service = new ModelCatalogService({
      adapters: [new FakeModelCatalogAdapter(({ signal }) => new Promise((_resolve, reject) => {
        discoveryStarted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }))],
      publishSnapshot,
    });
    const controller = new AbortController();
    const refresh = service.beforeInference({ signal: controller.signal });
    await started;

    controller.abort(new Error("trusted refresh deadline exceeded"));

    await expect(refresh).rejects.toThrow("trusted refresh deadline exceeded");
    expect(publishSnapshot).not.toHaveBeenCalled();
  });

  it("isolates cancellation between callers sharing a pre-inference refresh", async () => {
    let releaseDiscovery;
    let discoverySignal;
    const discoveryReleased = new Promise((resolve) => { releaseDiscovery = resolve; });
    const publishSnapshot = vi.fn(async () => {});
    const service = new ModelCatalogService({
      adapters: [new FakeModelCatalogAdapter(async ({ signal }) => {
        discoverySignal = signal;
        await discoveryReleased;
        return providerSnapshot({ models: [{ id: "shared" }] });
      })],
      publishSnapshot,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = service.beforeInference({ providerId: "fake", signal: firstController.signal });
    await vi.waitFor(() => expect(discoverySignal).toBeInstanceOf(AbortSignal));
    const second = service.beforeInference({ providerId: "fake", signal: secondController.signal });

    firstController.abort(new Error("first deadline expired"));

    await expect(first).rejects.toThrow("first deadline expired");
    expect(discoverySignal.aborted).toBe(false);
    releaseDiscovery();
    await expect(second).resolves.toMatchObject({ models: [{ id: "shared" }] });
    expect(publishSnapshot).toHaveBeenCalledOnce();
  });

  it("starts a fresh pre-inference refresh instead of joining an abandoned one", async () => {
    let calls = 0;
    let firstSignal;
    const service = new ModelCatalogService({
      adapters: [new FakeModelCatalogAdapter(({ signal }) => {
        calls += 1;
        if (calls === 1) {
          firstSignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return providerSnapshot({ models: [{ id: "replacement" }] });
      })],
      publishSnapshot: vi.fn(async () => {}),
    });
    const expiredController = new AbortController();
    const expired = service.beforeInference({ providerId: "fake", signal: expiredController.signal });
    await vi.waitFor(() => expect(firstSignal).toBeInstanceOf(AbortSignal));
    expiredController.abort(new Error("deadline expired"));

    const replacement = service.beforeInference({ providerId: "fake" });

    await expect(expired).rejects.toThrow("deadline expired");
    await expect(replacement).resolves.toMatchObject({ models: [{ id: "replacement" }] });
    expect(calls).toBe(2);
  });

  it("refreshes only the provider selected for inference", async () => {
    const fakeDiscover = vi.fn(async () => providerSnapshot({ providerId: "fake" }));
    const otherDiscover = vi.fn(async () => providerSnapshot({ providerId: "other" }));
    const service = new ModelCatalogService({
      adapters: [
        new FakeModelCatalogAdapter(fakeDiscover, "fake"),
        new FakeModelCatalogAdapter(otherDiscover, "other"),
      ],
      publishSnapshot: vi.fn(async () => {}),
    });

    await service.beforeInference({ providerId: "other" });

    expect(fakeDiscover).not.toHaveBeenCalled();
    expect(otherDiscover).toHaveBeenCalledOnce();
  });
});

describe("Codex model catalog adapter", () => {
  it("paginates model/list, preserves connector order and metadata, and does not infer latest", async () => {
    const requests = [];
    const model = (id, fields = {}) => ({
      id,
      model: `${id}-execution`,
      displayName: id.toUpperCase(),
      description: `${id} description`,
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
      defaultReasoningEffort: "low",
      inputModalities: ["text", "image"],
      supportsPersonality: true,
      serviceTiers: [{ id: "priority", name: "Priority", description: "Fast queue" }],
      defaultServiceTier: "priority",
      isDefault: false,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      ...fields,
    });
    const pages = [
      {
        data: [
          model("one", { isDefault: true }),
          model("hidden", { hidden: true }),
          model("two", {
            availabilityNux: { message: "Requires workspace access." },
            upgrade: "three",
            upgradeInfo: {
              model: "three",
              upgradeCopy: "Move to three",
              modelLink: "https://example.test/three",
              migrationMarkdown: "Use three",
            },
          }),
          model("three"),
        ],
        nextCursor: "page-2",
      },
      { data: [model("four"), model("five"), model("six", { inputModalities: undefined })], nextCursor: null },
    ];
    const credentials = {
      account: vi.fn(async () => ({ status: "connected", account: { email: "private@example.test" } })),
      request: vi.fn(async (method, params) => {
        requests.push({ method, params });
        return pages.shift();
      }),
    };

    const snapshot = await new CodexModelCatalogAdapter({ credentials, pageSize: 4 }).discover();

    expect(requests).toEqual([
      { method: "model/list", params: { cursor: null, limit: 4, includeHidden: true } },
      { method: "model/list", params: { cursor: "page-2", limit: 4, includeHidden: true } },
    ]);
    expect(snapshot.models.map(({ id }) => id)).toEqual([
      "one-execution",
      "hidden-execution",
      "two-execution",
      "three-execution",
      "four-execution",
      "five-execution",
      "six-execution",
    ]);
    expect(snapshot.models[0]).toMatchObject({
      id: "one-execution",
      catalogId: "one",
      executionModel: "one-execution",
    });
    expect(snapshot.models[1]).toMatchObject({ id: "hidden-execution", visible: false, availability: "available" });
    expect(snapshot.models[2]).toMatchObject({
      availabilityNotice: "Requires workspace access.",
      replacementModelId: "three",
      upgradeInfo: { modelId: "three", copy: "Move to three" },
      supportedEfforts: [{ id: "low", description: "Fast" }],
      defaultEffort: "low",
      serviceTiers: [{ id: "priority", name: "Priority", description: "Fast queue" }],
    });
    expect(snapshot.models[6].inputModalities).toEqual(["text", "image"]);
    expect(snapshot.systemFamily).toEqual({
      id: "codex",
      label: "Codex",
      readOnly: true,
      modelIds: ["one-execution", "two-execution", "three-execution", "four-execution", "five-execution"],
    });
    expect(snapshot).not.toHaveProperty("latest");
    expect(JSON.stringify(snapshot)).not.toContain("private@example.test");
  });

  it("does not request models until the Codex subscription is connected", async () => {
    const request = vi.fn();
    const disconnected = await new CodexModelCatalogAdapter({
      credentials: { account: async () => ({ status: "disconnected", account: null }), request },
    }).discover();
    const unavailable = await new CodexModelCatalogAdapter({
      credentials: { account: async () => ({ status: "unavailable", account: null, error: "Codex is missing." }), request },
    }).discover();

    expect(request).not.toHaveBeenCalled();
    expect(disconnected).toMatchObject({ provider: { status: "disconnected" }, models: [] });
    expect(unavailable).toMatchObject({ provider: { status: "unavailable", unavailableReason: "Codex is missing." }, models: [] });
  });

  it("fails closed on malformed pages or repeated cursors", async () => {
    const invalid = new CodexModelCatalogAdapter({
      credentials: { account: async () => ({ status: "connected" }), request: async () => ({ data: null, nextCursor: null }) },
    });
    await expect(invalid.discover()).rejects.toThrow("invalid data page");

    let calls = 0;
    const repeated = new CodexModelCatalogAdapter({
      credentials: {
        account: async () => ({ status: "connected" }),
        request: async () => ({ data: [], nextCursor: calls++ === 0 ? "same" : "same" }),
      },
    });
    await expect(repeated.discover()).rejects.toThrow("repeated a pagination cursor");
  });
});
