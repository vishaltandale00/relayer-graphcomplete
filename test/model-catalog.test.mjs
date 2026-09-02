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
  it("sanitizes provider snapshots and schedules trusted refreshes across the service lifecycle", async () => {
    const snapshot = sanitizeModelCatalogSnapshot(providerSnapshot({
      models: [
        { id: "one" },
        { id: "two", availability: "unavailable", unavailableReason: "Not enabled for this account." },
      ],
    }));

    expect(snapshot.models[0], "provider-local identity").toMatchObject({ providerId: "fake", id: "one", order: 0 });
    expect(snapshot.models[1], "provider-reported unavailability").toMatchObject({ availability: "unavailable", unavailableReason: "Not enabled for this account." });
    expect(Object.isFrozen(snapshot.models[0]), "frozen model entries").toBe(true);

    const invalidCases = [
      ["five-model system-family cap", () => {
        const oversized = providerSnapshot({ models: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id })) });
        oversized.systemFamily.modelIds = ["a", "b", "c", "d", "e", "f"];
        return oversized;
      }, "cannot contain more than five"],
      ["duplicate provider model id", () => providerSnapshot({
        models: [{ id: "duplicate" }, { id: "duplicate" }],
      }), "Duplicate provider model id"],
      ["leading-space id", () => providerSnapshot({ models: [{ id: " model" }] }), "models[0].id must be a stable identifier"],
      ["lone surrogate id", () => providerSnapshot({ models: [{ id: "model\uD800" }] }), "models[0].id must be a stable identifier"],
    ];
    expect(invalidCases, "sanitize rejection inventory").toHaveLength(4);
    for (const [label, build, message] of invalidCases) {
      expect.soft(() => sanitizeModelCatalogSnapshot(build()), label).toThrow(message);
    }

    const byteOrderMarkId = "\uFEFFmodel\uFEFF";
    const preserved = sanitizeModelCatalogSnapshot(providerSnapshot({
      models: [{ id: byteOrderMarkId, executionModel: "\uFEFFexecution\uFEFF" }],
    }));
    expect(preserved.models[0], "byte-exact identity preserved").toMatchObject({
      id: byteOrderMarkId,
      catalogId: byteOrderMarkId,
      executionModel: "\uFEFFexecution\uFEFF",
    });
    expect(preserved.systemFamily.modelIds, "byte-exact system family").toEqual([byteOrderMarkId]);
    expect(toProductCatalogSnapshot(preserved), "byte-exact product mapping").toMatchObject({
      models: [{ id: byteOrderMarkId, metadata: { executionModel: "\uFEFFexecution\uFEFF" } }],
      systemFamily: { modelIds: [byteOrderMarkId] },
    });

    expect(toProductCatalogSnapshot(snapshot), "product catalog mapping").toMatchObject({
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

    const published = [];
    let call = 0;
    const lifecycleService = new ModelCatalogService({
      adapters: [new FakeModelCatalogAdapter(async () => {
        call += 1;
        if (call === 6) throw new Error("provider login expired");
        return providerSnapshot({ models: [{ id: `model-${call}` }] });
      })],
      publishSnapshot: async (publishedSnapshot, context) => published.push({ snapshot: publishedSnapshot, context }),
    });

    await lifecycleService.startup();
    await lifecycleService.providerChanged("fake");
    await lifecycleService.settingsOpened();
    await lifecycleService.explicitRefresh("fake");
    await lifecycleService.beforeInference();
    await expect(lifecycleService.explicitRefresh(), "failed refresh rejects")
      .rejects.toThrow("provider login expired");

    expect(published.map(({ context }) => context.reason), "every lifecycle trigger publishes")
      .toEqual(["startup", "provider-change", "settings-open", "explicit", "pre-inference"]);
    expect(published[0].snapshot, "startup snapshot").toMatchObject({
      providerId: "fake",
      connected: true,
      models: [{ id: "model-1", available: true }],
      systemFamily: { key: "fake", modelIds: ["model-1"] },
    });
    expect(published.at(-1).snapshot, "last good snapshot survives a failed refresh")
      .toMatchObject({ models: [{ id: "model-5" }] });

    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const concurrentPublished = [];
    let releaseDiscovery;
    const discoveryReleased = new Promise((resolve) => { releaseDiscovery = resolve; });
    const dedupeService = new ModelCatalogService({
      adapters: [new FakeModelCatalogAdapter(async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await discoveryReleased;
        active -= 1;
        return providerSnapshot({ models: [{ id: `model-${calls}` }] });
      })],
      publishSnapshot: async (publishedSnapshot, context) => concurrentPublished.push({ snapshot: publishedSnapshot, context }),
    });

    const settingsRefresh = dedupeService.settingsOpened();
    await vi.waitFor(() => expect(calls, "in-flight discovery started").toBe(1));
    const firstInference = dedupeService.beforeInference();
    const secondInference = dedupeService.beforeInference();
    releaseDiscovery();
    await Promise.all([settingsRefresh, firstInference, secondInference]);

    expect(calls, "concurrent callers share one discovery").toBe(1);
    expect(maximumActive, "no overlapping discovery").toBe(1);
    expect(concurrentPublished, "one publication for shared refresh").toHaveLength(1);
    expect(concurrentPublished[0].context.reason, "shared refresh keeps its trigger").toBe("settings-open");

    let discoveryStarted;
    const started = new Promise((resolve) => { discoveryStarted = resolve; });
    const publishAfterAbort = vi.fn();
    const abortService = new ModelCatalogService({
      adapters: [new FakeModelCatalogAdapter(({ signal }) => new Promise((_resolve, reject) => {
        discoveryStarted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }))],
      publishSnapshot: publishAfterAbort,
    });
    const controller = new AbortController();
    const abortedRefresh = abortService.beforeInference({ signal: controller.signal });
    await started;

    controller.abort(new Error("trusted refresh deadline exceeded"));

    await expect(abortedRefresh, "aborted refresh rejects").rejects.toThrow("trusted refresh deadline exceeded");
    expect(publishAfterAbort, "aborted refresh never publishes").not.toHaveBeenCalled();

    let releaseShared;
    let sharedSignal;
    const sharedReleased = new Promise((resolve) => { releaseShared = resolve; });
    const isolationPublish = vi.fn(async () => {});
    const isolationService = new ModelCatalogService({
      adapters: [new FakeModelCatalogAdapter(async ({ signal }) => {
        sharedSignal = signal;
        await sharedReleased;
        return providerSnapshot({ models: [{ id: "shared" }] });
      })],
      publishSnapshot: isolationPublish,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstCaller = isolationService.beforeInference({ providerId: "fake", signal: firstController.signal });
    await vi.waitFor(() => expect(sharedSignal, "shared discovery running").toBeInstanceOf(AbortSignal));
    const secondCaller = isolationService.beforeInference({ providerId: "fake", signal: secondController.signal });

    firstController.abort(new Error("first deadline expired"));

    await expect(firstCaller, "cancelled caller rejects").rejects.toThrow("first deadline expired");
    expect(sharedSignal.aborted, "cancellation does not abort the shared discovery").toBe(false);
    releaseShared();
    await expect(secondCaller, "remaining caller still resolves").resolves.toMatchObject({ models: [{ id: "shared" }] });
    expect(isolationPublish, "shared discovery publishes once").toHaveBeenCalledOnce();

    let abandonedCalls = 0;
    let firstSignal;
    const abandonedService = new ModelCatalogService({
      adapters: [new FakeModelCatalogAdapter(({ signal }) => {
        abandonedCalls += 1;
        if (abandonedCalls === 1) {
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
    const expired = abandonedService.beforeInference({ providerId: "fake", signal: expiredController.signal });
    await vi.waitFor(() => expect(firstSignal, "abandoned discovery running").toBeInstanceOf(AbortSignal));
    expiredController.abort(new Error("deadline expired"));

    const replacement = abandonedService.beforeInference({ providerId: "fake" });

    await expect(expired, "abandoned refresh rejects").rejects.toThrow("deadline expired");
    await expect(replacement, "fresh refresh after abandonment").resolves.toMatchObject({ models: [{ id: "replacement" }] });
    expect(abandonedCalls, "abandoned refresh is not joined").toBe(2);

    const fakeDiscover = vi.fn(async () => providerSnapshot({ providerId: "fake" }));
    const otherDiscover = vi.fn(async () => providerSnapshot({ providerId: "other" }));
    const scopedService = new ModelCatalogService({
      adapters: [
        new FakeModelCatalogAdapter(fakeDiscover, "fake"),
        new FakeModelCatalogAdapter(otherDiscover, "other"),
      ],
      publishSnapshot: vi.fn(async () => {}),
    });

    await scopedService.beforeInference({ providerId: "other" });

    expect(fakeDiscover, "other providers are not refreshed").not.toHaveBeenCalled();
    expect(otherDiscover, "selected provider is refreshed").toHaveBeenCalledOnce();
  }, 20_000);

  it("Codex discovery paginates connected accounts and fails closed before or without a live subscription", async () => {
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
          model("hidden", { hidden: true, isDefault: true }),
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
          model("three", { isDefault: true }),
        ],
        nextCursor: "page-2",
      },
      { data: [model("four"), model("five"), model("six", { inputModalities: undefined, isDefault: true })], nextCursor: null },
    ];
    const credentials = {
      account: vi.fn(async () => ({ status: "connected", account: { email: "private@example.test" } })),
      request: vi.fn(async (method, params) => {
        requests.push({ method, params });
        return pages.shift();
      }),
    };

    const snapshot = await new CodexModelCatalogAdapter({ credentials, pageSize: 4 }).discover();

    expect(requests, "cursor pagination with hidden models").toEqual([
      { method: "model/list", params: { cursor: null, limit: 4, includeHidden: true } },
      { method: "model/list", params: { cursor: "page-2", limit: 4, includeHidden: true } },
    ]);
    expect(snapshot.models.map(({ id }) => id), "connector order preserved").toEqual([
      "one-execution",
      "hidden-execution",
      "two-execution",
      "three-execution",
      "four-execution",
      "five-execution",
      "six-execution",
    ]);
    expect(snapshot.models[0], "execution identity mapping").toMatchObject({
      id: "one-execution",
      catalogId: "one",
      executionModel: "one-execution",
    });
    expect(snapshot.models[1], "hidden model visibility").toMatchObject({ id: "hidden-execution", visible: false, availability: "available" });
    expect(snapshot.models[2], "upgrade and availability metadata").toMatchObject({
      availabilityNotice: "Requires workspace access.",
      replacementModelId: "three",
      upgradeInfo: { modelId: "three", copy: "Move to three" },
      supportedEfforts: [{ id: "low", description: "Fast" }],
      defaultEffort: "low",
      serviceTiers: [{ id: "priority", name: "Priority", description: "Fast queue" }],
    });
    expect(snapshot.models[6].inputModalities, "missing modalities default").toEqual(["text", "image"]);
    expect(snapshot.systemFamily, "read-only Codex system family").toEqual({
      id: "codex",
      label: "Codex",
      readOnly: true,
      modelIds: ["one-execution", "three-execution", "six-execution"],
    });
    expect(snapshot, "no inferred latest model").not.toHaveProperty("latest");
    expect(JSON.stringify(snapshot), "no account PII in the snapshot").not.toContain("private@example.test");

    const request = vi.fn();
    const disconnected = await new CodexModelCatalogAdapter({
      credentials: { account: async () => ({ status: "disconnected", account: null }), request },
    }).discover();
    const unavailable = await new CodexModelCatalogAdapter({
      credentials: { account: async () => ({ status: "unavailable", account: null, error: "opaque-private-value" }), request },
    }).discover();

    expect(request, "no model requests before a connected subscription").not.toHaveBeenCalled();
    expect(disconnected, "disconnected subscription").toMatchObject({ provider: { status: "disconnected" }, models: [] });
    expect(unavailable, "unavailable subscription hides the opaque error").toMatchObject({
      provider: { status: "unavailable", unavailableReason: "Codex subscription is unavailable." }, models: [],
    });
    expect(JSON.stringify(unavailable), "opaque error never leaks").not.toContain("opaque-private-value");

    const invalid = new CodexModelCatalogAdapter({
      credentials: { account: async () => ({ status: "connected" }), request: async () => ({ data: null, nextCursor: null }) },
    });
    await expect(invalid.discover(), "malformed page fails closed").rejects.toThrow("invalid data page");

    let cursorCalls = 0;
    const repeated = new CodexModelCatalogAdapter({
      credentials: {
        account: async () => ({ status: "connected" }),
        request: async () => ({ data: [], nextCursor: cursorCalls++ === 0 ? "same" : "same" }),
      },
    });
    await expect(repeated.discover(), "repeated cursor fails closed").rejects.toThrow("repeated a pagination cursor");
  }, 10_000);
});
