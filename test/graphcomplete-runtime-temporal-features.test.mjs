import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  GraphCompleteRuntimeService,
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

  it("leaves every temporal feature off without the developer switch", () => {
    expect(developerTemporalFeatures({})).toEqual({});
    expect(developerTemporalFeatures({ RELAYER_DEV_PROVIDER_RECURSION: "0" })).toEqual({});
    expect(developerTemporalFeatures({ RELAYER_DEV_PROVIDER_RECURSION: "true" })).toEqual({});
  });

  it("enables the whole persisted chain recursion depends on", () => {
    expect(developerTemporalFeatures({ RELAYER_DEV_PROVIDER_RECURSION: "1" })).toEqual({
      schemaRead: true,
      rootCurrentWrite: true,
      projectionUi: true,
      invokeResolution: true,
      providerRecursion: true,
    });
  });

  it("passes the enabled chain to the graph server it starts", async () => {
    const { service, spawned } = spawnedGraphArguments(
      developerTemporalFeatures({ RELAYER_DEV_PROVIDER_RECURSION: "1" }),
    );

    await expect(service.start()).rejects.toThrow("startup is not exercised");

    expect(spawned[0]).toEqual(expect.arrayContaining([
      "--temporal-schema-read",
      "--temporal-root-current-write",
      "--temporal-projection-ui",
      "--temporal-invoke-resolution",
      "--temporal-provider-recursion",
    ]));
  });

  it("starts the graph server with no temporal switch by default", async () => {
    const { service, spawned } = spawnedGraphArguments(developerTemporalFeatures({}));

    await expect(service.start()).rejects.toThrow("startup is not exercised");

    expect(spawned[0].filter((argument) => argument.startsWith("--temporal"))).toEqual([]);
  });
});
