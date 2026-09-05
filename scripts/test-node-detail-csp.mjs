import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
let window;

app.setName("Relayer Node Detail CSP Check");
app.commandLine.appendSwitch("disable-gpu");

function browserProof() {
  return `(async () => {
    const { mountCompiledNodeDetail } = await import("./src/product-workspace/node-detail-runtime.js");
    const canonicalJson = (value) => {
      if (Array.isArray(value)) return \`[\${value.map(canonicalJson).join(",")}]\`;
      if (value !== null && typeof value === "object") {
        return \`{\${Object.keys(value).sort().map((key) => \`\${JSON.stringify(key)}:\${canonicalJson(value[key])}\`).join(",")}}\`;
      }
      return JSON.stringify(value);
    };
    const content = {
      version: 1,
      components: [{ id: "probe", order: 0, html: '<section class="probe"><img alt="CSP visual" data-asset-mount="visual"></section>', css: ".probe{padding-left:13px}" }],
      mounts: [{ id: "visual", componentId: "probe", kind: "asset", host: "img", assetId: "visual" }],
      assets: [{ id: "visual", digestSha256: "a".repeat(64), mediaType: "image/svg+xml", representation: "image" }],
    };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(content)));
    const integritySha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const host = document.createElement("div");
    host.id = "node-detail-csp-proof";
    document.body.append(host);
    const blobUrl = URL.createObjectURL(new Blob([
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
    ], { type: "image/svg+xml" }));
    try {
      const runtime = await mountCompiledNodeDetail({
        host,
        detail: { ...content, integritySha256 },
        resolveAsset: async () => ({
          digestSha256: "a".repeat(64),
          mediaType: "image/svg+xml",
          url: blobUrl,
        }),
      });
      const image = runtime.shadowRoot.querySelector("img");
      await new Promise((resolveLoad, rejectLoad) => {
        if (image.complete && image.naturalWidth > 0) return resolveLoad();
        if (image.complete) return rejectLoad(new Error("Blob image completed without decoded pixels under Product CSP."));
        const timeout = setTimeout(() => rejectLoad(new Error("Timed out loading blob image under Product CSP.")), 5000);
        image.addEventListener("load", () => { clearTimeout(timeout); resolveLoad(); }, { once: true });
        image.addEventListener("error", () => { clearTimeout(timeout); rejectLoad(new Error("Blob image was blocked by Product CSP.")); }, { once: true });
      });
      const authored = getComputedStyle(runtime.shadowRoot.querySelector(".probe"));
      const contained = getComputedStyle(host);
      return {
        status: runtime.status,
        paddingLeft: authored.paddingLeft,
        contain: contained.contain,
        naturalWidth: image.naturalWidth,
        styleElements: runtime.shadowRoot.querySelectorAll("style").length,
        adoptedStyleSheets: runtime.shadowRoot.adoptedStyleSheets.length,
      };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  })()`;
}

async function run() {
  process.stdout.write("Electron ready; loading Product renderer.\n");
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(resolve(repositoryRoot, "desktop", "renderer", "index.html"));
  process.stdout.write("Product renderer loaded; mounting Node Detail.\n");
  const result = await window.webContents.executeJavaScript(browserProof());
  if (result.status !== "mounted"
    || result.paddingLeft !== "13px"
    || (result.contain !== "content" && !result.contain.includes("layout"))
    || result.naturalWidth !== 2
    || result.styleElements !== 0
    || result.adoptedStyleSheets !== 2) {
    throw new Error(`Node Detail Product CSP proof failed: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`Node Detail Product CSP proof passed: ${JSON.stringify(result)}\n`);
}

app.whenReady().then(run).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}).finally(() => {
  window?.destroy();
  app.quit();
});
