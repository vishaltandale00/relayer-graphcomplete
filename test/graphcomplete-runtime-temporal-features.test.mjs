import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  GraphCompleteRuntimeService,
  RECURSIVE_TEMPORAL_FEATURES,
  developerTemporalFeatures,
} from "../desktop/main/services/graphcomplete-runtime.mjs";

const runtimeDirectories = [];

function spawnedGraphArguments(temporalFeatures) {
  const spawned = [];
  const userDataDirectory = mkdtempSync(join(tmpdir(), "relayer-temporal-features-"));
  runtimeDirectories.push(userDataDirectory);
  const service = new GraphCompleteRuntimeService({
    userDataDirectory,
    graphServerBinary: "/tmp/relayer-graph-server",
    configurationPaths: [],
    temporalFeatures,
    spawnProcess: (_binary, args) => {
      spawned.push(args);
      throw new Error("startup is not exercised by this test");
    },
  });
  return { service, spawned };
}

describe("developer recursion enable path", () => {
  afterEach(() => {
    while (runtimeDirectories.length > 0) {
      rmSync(runtimeDirectories.pop(), { recursive: true, force: true });
    }
  });

  it("enables the whole persisted recursion chain only behind the developer switch and passes it to the graph server", async () => {
    expect(developerTemporalFeatures({}), "no switch leaves every temporal feature off").toEqual({});
    expect(developerTemporalFeatures({ RELAYER_DEV_PROVIDER_RECURSION: "0" }), "explicit zero leaves features off").toEqual({});
    expect(developerTemporalFeatures({ RELAYER_DEV_PROVIDER_RECURSION: "true" }), "non-canonical truthy value leaves features off").toEqual({});

    expect(RECURSIVE_TEMPORAL_FEATURES, "persisted chain recursion depends on").toEqual({
      schemaRead: true,
      rootCurrentWrite: true,
      projectionUi: true,
      invokeResolution: true,
      providerRecursion: true,
    });
    expect(developerTemporalFeatures({ RELAYER_DEV_PROVIDER_RECURSION: "1" }), "developer switch returns the exact chain")
      .toBe(RECURSIVE_TEMPORAL_FEATURES);

    const enabled = spawnedGraphArguments(RECURSIVE_TEMPORAL_FEATURES);
    await expect(enabled.service.start(), "enabled chain startup attempt").rejects.toThrow("startup is not exercised");
    expect(enabled.spawned[0], "enabled chain forwarded to the graph server").toEqual(expect.arrayContaining([
      "--temporal-schema-read",
      "--temporal-root-current-write",
      "--temporal-projection-ui",
      "--temporal-invoke-resolution",
      "--temporal-provider-recursion",
    ]));

    const defaulted = spawnedGraphArguments(developerTemporalFeatures({}));
    await expect(defaulted.service.start(), "default startup attempt").rejects.toThrow("startup is not exercised");
    expect(
      defaulted.spawned[0].filter((argument) => argument.startsWith("--temporal")),
      "no temporal switch by default",
    ).toEqual([]);
  });
});
