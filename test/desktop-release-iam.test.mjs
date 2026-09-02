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
  it("limits Preview and Stable to their sealed release objects and trusts only the pinned repository environments", async () => {
    const preview = await readPolicy("preview-policy.json");
    expect(preview.Statement, "Preview is one object-write statement").toHaveLength(1);
    const objects = preview.Statement.find((statement) => Array.isArray(statement.Action));
    expect(objects.Action, "Preview gets and puts objects only").toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(preview.Statement.some((statement) => statement.Action === "s3:ListBucket"), "no bucket listing").toBe(false);
    expect(preview.Statement.flatMap(resourcesFor), "no bare bucket authority").not.toContain(bucketArn);

    const expectedPreview = Object.values(DESKTOP_RELEASE_TARGETS).flatMap((target) => {
      const resources = targetResources(target);
      return [resources.release, resources.previewPointer, resources.previewHistory, resources.previewReceipt];
    });
    expect(resourcesFor(objects).sort(), "Preview limited to release objects and Preview control objects").toEqual(expectedPreview.sort());

    const stable = await readPolicy("stable-policy.json");
    expect(stable.Statement, "Stable is a read/write statement pair").toHaveLength(2);
    const read = stable.Statement.find((statement) => statement.Action === "s3:GetObject");
    const write = stable.Statement.find((statement) => statement.Action === "s3:PutObject");
    expect(stable.Statement.some((statement) => statement.Action === "s3:ListBucket"), "no bucket listing for Stable").toBe(false);
    expect(stable.Statement.flatMap(resourcesFor), "no bare bucket authority for Stable").not.toContain(bucketArn);

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
    expect(resourcesFor(read).sort(), "Stable reads Preview evidence plus Stable control objects").toEqual(expectedRead.sort());
    expect(resourcesFor(write).sort(), "Stable writes only Stable control objects").toEqual(expectedWrite.sort());
    expect(resourcesFor(write), "Stable never writes release artifacts").not.toEqual(expect.arrayContaining(
      Object.values(DESKTOP_RELEASE_TARGETS).map((target) => targetResources(target).release),
    ));

    const trustExpectations = [
      ["preview-trust-policy.json", "desktop-update-preview"],
      ["stable-trust-policy.json", "desktop-update-stable-promotion"],
    ];
    for (const [file, environment] of trustExpectations) {
      const policy = await readPolicy(file);
      expect(policy.Statement, `${file} trusts only the exact repository environment subject`).toEqual([expect.objectContaining({
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
