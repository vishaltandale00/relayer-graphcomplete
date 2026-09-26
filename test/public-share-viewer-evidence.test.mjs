import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const captureSource = readFileSync(
  resolve(repositoryRoot, "scripts/capture-public-share-viewer-evidence.mjs"),
  "utf8",
);
const viewerMainSource = readFileSync(
  resolve(repositoryRoot, "desktop/renderer/src/public-share-viewer/main.js"),
  "utf8",
);
const viewerTemplateSource = readFileSync(
  resolve(repositoryRoot, "desktop/renderer/src/public-share-viewer/template.js"),
  "utf8",
);
const evidenceReadme = readFileSync(
  resolve(repositoryRoot, "docs/evidence/issue-471-public-share-viewer/README.md"),
  "utf8",
);
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const affectedModules = JSON.parse(readFileSync(
  resolve(repositoryRoot, "scripts/ci/affected-modules.v1.json"),
  "utf8",
));

describe("public share viewer evidence seam", () => {
  it("captures the real Electron ProductWorkspace at the required desktop and mobile sizes", () => {
    expect(captureSource).toContain("new BrowserWindow");
    expect(captureSource).toContain("width: 1440");
    expect(captureSource).toContain("height: 1000");
    expect(captureSource).toContain("width: 375");
    expect(captureSource).toContain("height: 812");
    expect(captureSource).toContain("mobile-node-details");
    expect(captureSource).toContain("capturePage");
    expect(captureSource).toContain("requestAnimationFrame(() => requestAnimationFrame");
    expect(viewerMainSource).toContain("createProductWorkspace");
  });

  it("keeps the evidence deterministic and offline", () => {
    expect(captureSource).toContain("synthetic");
    expect(captureSource).toContain("networkRequests");
    expect(captureSource).toContain("location.href");
    expect(captureSource).toContain("originalUrl");
    expect(captureSource).toContain("127.0.0.1");
    expect(viewerTemplateSource).toContain("connect-src 'none'");
    expect(captureSource).toContain("RELAYER_CAPTURE_PUBLIC_SHARE_VIEWER_EVIDENCE");
    expect(captureSource).toContain("commit:");
    expect(captureSource).toContain("sourceFiles");
    expect(captureSource).toContain("downloadCardInsideWorkspace");
    expect(captureSource).toContain("environmentPanelAbsent");
    expect(captureSource).toContain("mutationControlsInert");
    expect(captureSource).toContain("paidInferenceCalls: 0");
  });

  it("documents the evidence boundaries and generated artifacts", () => {
    expect(evidenceReadme).toContain("1440x1000");
    expect(evidenceReadme).toContain("375x812");
    expect(evidenceReadme).toContain("Node Details");
    expect(evidenceReadme).toContain("unchanged URL");
    expect(evidenceReadme).toContain("no network");
    expect(evidenceReadme).toContain("synthetic");
    expect(evidenceReadme).toContain("source-bound");
    expect(packageJson.scripts["evidence:public-share-viewer"])
      .toBe("RELAYER_CAPTURE_PUBLIC_SHARE_VIEWER_EVIDENCE=1 electron scripts/capture-public-share-viewer-evidence.mjs");
    expect(affectedModules.scriptOwners).toContainEqual({
      exact: "scripts/capture-public-share-viewer-evidence.mjs",
      chapters: ["vitest"],
      vitestFiles: ["test/public-share-viewer-evidence.test.mjs"],
    });
  });
});
