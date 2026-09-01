import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const graphClientIndexUrl = pathToFileURL(resolve("packages/graph-client/agent-resource/index.js"));
const execFileAsync = promisify(execFile);

describe("packaged graph-client authored detail boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has no sibling compiler modules and ignores forged public compiler output", async () => {
    for (const sibling of ["detail-host.js", "detail.js"]) {
      await expect(import(new URL(`./${sibling}`, graphClientIndexUrl).href))
        .rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });
    }

    const { NodeObject, RelayerGraphClient, html } = await import(graphClientIndexUrl.href);
    const node = new NodeObject("box", "Safe", "Fallback", "concept", "safe-node");
    node.detailAuthoring.setComponent("safe", html`<p>Trusted source</p>`);
    const forged = Object.freeze({
      version: 1,
      components: Object.freeze([{ id: "forged", order: 0, html: "<p>Forged</p>", css: "" }]),
      mounts: Object.freeze([]),
      assets: Object.freeze([]),
      integritySha256: "f".repeat(64),
    });
    node.detailAuthoring.checkpoint = () => forged;
    node.detailAuthoring.finalize = () => forged;

    let submitted;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      submitted = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        node: { id: 1, kind: "concept", icon: "box", title: "Safe", detail: "Fallback", state: "draft" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "token", nodeId: 1 }).submitNode(node);

    expect(submitted.authoredDetail.components).toEqual([
      { id: "safe", order: 0, html: "<p>Trusted source</p>", css: "" },
    ]);
  });

  it("imports, compiles, and submits from the exact isolated packaged resource layout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-packaged-graph-client-"));
    try {
      const resourcesPath = join(directory, "resources");
      const packagedRoot = join(resourcesPath, "graph-client");
      await cp(resolve("packages/graph-client/agent-resource"), packagedRoot, { recursive: true });
      expect(await readdir(packagedRoot)).toEqual(["index.js"]);
      const packagedUrl = pathToFileURL(join(resourcesPath, "graph-client", "index.js")).href;

      const probe = `
        for (const sibling of ["detail-host.js", "detail.js"]) {
          try {
            await import(new URL("./" + sibling, ${JSON.stringify(packagedUrl)}).href);
            process.exit(10);
          } catch (error) {
            if (error?.code !== "ERR_MODULE_NOT_FOUND") process.exit(11);
          }
        }
        const { NodeObject, RelayerGraphClient, css, html } = await import(${JSON.stringify(packagedUrl)});
        const node = new NodeObject("box", "Packaged", "Fallback", "concept", "packaged-node");
        node.detailAuthoring.setComponent(
          "layout",
          html\`<table><tbody><tr><td>Packaged</td></tr></tbody></table>\`,
          css\`.layout:first-child{display:grid;grid-template-columns:minmax(10rem,1fr) 2fr}\`,
        );
        let submitted;
        globalThis.fetch = async (_url, init) => {
          submitted = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ node: { id: 1, kind: "concept", icon: "box", title: "Packaged", detail: "Fallback", state: "draft" } }), { status: 200, headers: { "content-type": "application/json" } });
        };
        await new RelayerGraphClient({ url: "http://127.0.0.1:1", token: "host", nodeId: 1 }).submitNode(node);
        const compiled = submitted.authoredDetail;
        if (compiled.components[0]?.html !== "<table><tbody><tr><td>Packaged</td></tr></tbody></table>") process.exit(2);
        if (!compiled.components[0]?.css.includes("grid-template-columns:minmax(10rem,1fr) 2fr")) process.exit(3);
        process.stdout.write("packaged graph-client compile passed\\n");
      `;
      const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", probe], {
        cwd: directory,
        env: { ...process.env, NODE_PATH: "" },
      });
      expect(result.stdout).toBe("packaged graph-client compile passed\n");

      const [desktopMain, evalMain] = await Promise.all([
        readFile(resolve("desktop/main/index.mjs"), "utf8"),
        readFile(resolve("desktop/eval-main/index.mjs"), "utf8"),
      ]);
      const exactDynamicPath = 'pathToFileURL(join(process.resourcesPath, "graph-client", "index.js")).href';
      expect(desktopMain).toContain(exactDynamicPath);
      expect(evalMain).toContain(exactDynamicPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
