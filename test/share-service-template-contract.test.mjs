import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const templateUrl = new URL("../infra/aws/share-service/template.yaml", import.meta.url);

describe("share-service infrastructure contract", () => {
  it("preserves the 16 MiB staged transport and streamed no-cache page boundary", async () => {
    const template = await readFile(templateUrl, "utf8");

    expect(template).toContain('SNAPSHOT_MAX_BYTES: "16777216"');
    expect(template).toContain("Prefix: staging/");
    expect(template).toContain("ExpirationInDays: 1");
    expect(template).toContain("InvokeMode: RESPONSE_STREAM");
    expect(template).toContain("PathPattern: /t/*");
    expect(template.match(/CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/gu)).toHaveLength(2);
    expect(template).not.toContain("snapshots/*\n            Condition:\n              StringEquals:\n                AWS:SourceArn");
  });

  it("grants the runtime the conditional transaction needed for attempt and quota atomicity", async () => {
    const template = await readFile(templateUrl, "utf8");
    const runtimePolicy = template.slice(
      template.indexOf("- Sid: ShareRows"),
      template.indexOf("  ShareFunction:", template.indexOf("- Sid: ShareRows")),
    );

    expect(runtimePolicy).toContain("dynamodb:ConditionCheckItem");
    expect(runtimePolicy).not.toContain("dynamodb:TransactWriteItems");
    expect(runtimePolicy).toContain("!GetAtt SharesTable.Arn");
    expect(runtimePolicy).toContain("index/byOwner");
    expect(runtimePolicy).not.toContain("Resource: \"*\"");
  });
});
