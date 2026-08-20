import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DESKTOP_RELEASE_TARGETS } from "../desktop/release/contract.mjs";

const bucketArn = "arn:aws:s3:::relayer-desktop-updates-647746916062";
const policyDirectory = new URL("../infra/aws/desktop-release-authority/", import.meta.url);

async function readPolicy(name) {
  return JSON.parse(await readFile(new URL(name, policyDirectory), "utf8"));
}

function resourcesFor(statement) {
  return Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
}

function targetResources(target) {
  return {
    release: `${bucketArn}/${target.publicPrefix}/releases/*`,
    previewPointer: `${bucketArn}/${target.publicPrefix}/${target.channels.preview.manifestName}`,
    stablePointer: `${bucketArn}/${target.publicPrefix}/${target.channels.stable.manifestName}`,
    previewHistory: `${bucketArn}/private/history/${target.key}/beta/*`,
    stableHistory: `${bucketArn}/private/history/${target.key}/latest/*`,
    previewReceipt: `${bucketArn}/private/receipts/${target.key}/preview/*`,
    stableReceipt: `${bucketArn}/private/receipts/${target.key}/stable/*`,
  };
}

describe("desktop release AWS authority", () => {
  it("limits Preview to target release objects and Preview control objects", async () => {
    const policy = await readPolicy("preview-policy.json");
    expect(policy.Statement).toHaveLength(1);
    const objects = policy.Statement.find((statement) => Array.isArray(statement.Action));
    expect(objects.Action).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(policy.Statement.some((statement) => statement.Action === "s3:ListBucket")).toBe(false);
    expect(policy.Statement.flatMap(resourcesFor)).not.toContain(bucketArn);

    const expected = Object.values(DESKTOP_RELEASE_TARGETS).flatMap((target) => {
      const resources = targetResources(target);
      return [resources.release, resources.previewPointer, resources.previewHistory, resources.previewReceipt];
    });
    expect(resourcesFor(objects).sort()).toEqual(expected.sort());
  });

  it("lets Stable read Preview evidence but write only Stable control objects", async () => {
    const policy = await readPolicy("stable-policy.json");
    expect(policy.Statement).toHaveLength(2);
    const read = policy.Statement.find((statement) => statement.Action === "s3:GetObject");
    const write = policy.Statement.find((statement) => statement.Action === "s3:PutObject");
    expect(policy.Statement.some((statement) => statement.Action === "s3:ListBucket")).toBe(false);
    expect(policy.Statement.flatMap(resourcesFor)).not.toContain(bucketArn);

    const expectedRead = Object.values(DESKTOP_RELEASE_TARGETS).flatMap((target) => {
      const resources = targetResources(target);
      return [
        resources.release,
        resources.stablePointer,
        resources.previewHistory,
        resources.stableHistory,
        resources.previewReceipt,
        resources.stableReceipt,
      ];
    });
    const expectedWrite = Object.values(DESKTOP_RELEASE_TARGETS).flatMap((target) => {
      const resources = targetResources(target);
      return [resources.stablePointer, resources.stableHistory, resources.stableReceipt];
    });
    expect(resourcesFor(read).sort()).toEqual(expectedRead.sort());
    expect(resourcesFor(write).sort()).toEqual(expectedWrite.sort());
    expect(resourcesFor(write)).not.toEqual(expect.arrayContaining(
      Object.values(DESKTOP_RELEASE_TARGETS).map((target) => targetResources(target).release),
    ));
  });

  it("trusts only the exact immutable repository and protected environment subjects", async () => {
    const expectations = [
      ["preview-trust-policy.json", "desktop-update-preview"],
      ["stable-trust-policy.json", "desktop-update-stable-promotion"],
    ];
    for (const [file, environment] of expectations) {
      const policy = await readPolicy(file);
      expect(policy.Statement).toEqual([expect.objectContaining({
        Effect: "Allow",
        Principal: {
          Federated: "arn:aws:iam::647746916062:oidc-provider/token.actions.githubusercontent.com",
        },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub":
              `repo:vishaltandale00@9222298/relayer-graphcomplete@1327816644:environment:${environment}`,
          },
        },
      })]);
    }
  });
});
