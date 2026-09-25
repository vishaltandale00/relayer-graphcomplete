const DEFAULT_ASSET_BASE = "/";
const DEFAULT_INSTALL_URL = "https://app.relayerlabs.ai/desktop/login";
const DEFAULT_DESCRIPTION = "A read-only Relayer conversation snapshot.";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeAssetBase(value) {
  const base = value == null ? DEFAULT_ASSET_BASE : String(value);
  if (!base || /[\u0000-\u0020<>"']/.test(base) || !/^(?:\.|\/)/.test(base)) {
    throw new TypeError("Public viewer assetBase must be a same-origin relative path.");
  }
  return base.replace(/\/+$/, "");
}

function assetUrl(base, file) {
  return `${base}/${file}`;
}

function viewerAsset(manifest, key, fallback, base) {
  if (manifest == null) return assetUrl(base, fallback);
  const value = manifest?.version === 1 ? manifest.assets?.[key] : null;
  if (typeof value !== "string" || !/^assets\/[A-Za-z0-9._/-]+$/u.test(value) || value.includes("..")) {
    throw new TypeError(`Public viewer asset manifest is missing ${key}.`);
  }
  return `/${value}`;
}

function safeInstallUrl(value) {
  const url = value == null ? DEFAULT_INSTALL_URL : String(value);
  if (url !== DEFAULT_INSTALL_URL && !/^\/t\/[a-f0-9]{32}\/install$/u.test(url)) {
    throw new TypeError("Public viewer installUrl is fixed to the product install destination.");
  }
  return url;
}

function snapshotText(value) {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder("utf-8", { fatal: true }).decode(value);
  throw new TypeError("Public viewer snapshot must be UTF-8 JSONL text or bytes.");
}

function safeJsonScriptText(value) {
  return JSON.stringify(snapshotText(value))
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function publicViewerCsp() {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Render the browser shell used by the share page. The service should call
 * this with the exact frozen JSONL bytes returned by the snapshot boundary;
 * the browser never fetches those bytes and never receives a bearer token.
 */
export function renderPublicViewerTemplate({
  snapshot,
  title = "Shared conversation",
  description = DEFAULT_DESCRIPTION,
  assetBase = DEFAULT_ASSET_BASE,
  assetManifest = null,
  installUrl = DEFAULT_INSTALL_URL,
} = {}) {
  const base = safeAssetBase(assetBase);
  const install = safeInstallUrl(installUrl);
  const safeTitle = Array.from(String(title || "Shared conversation")).slice(0, 120).join("");
  const safeDescription = Array.from(String(description || DEFAULT_DESCRIPTION)).slice(0, 240).join("");
  const snapshotLiteral = safeJsonScriptText(snapshot);
  const csp = escapeHtml(publicViewerCsp());
  const logo = escapeHtml(viewerAsset(assetManifest, "logo", "assets/relayer-logo.svg", base));
  const ogImage = escapeHtml(viewerAsset(assetManifest, "ogImage", "assets/relayer-share-og.svg", base));
  const viewerScript = escapeHtml(viewerAsset(assetManifest, "viewerScript", "src/public-share-viewer/main.js", base));
  const viewerStyles = escapeHtml(viewerAsset(assetManifest, "viewerStyles", "src/public-share-viewer/viewer.css", base));
  const workspaceStyles = escapeHtml(viewerAsset(assetManifest, "workspaceStyles", "styles.css", base));
  const lucideScript = escapeHtml(viewerAsset(assetManifest, "lucideScript", "vendor/lucide.min.js", base));
  const markedScript = escapeHtml(viewerAsset(assetManifest, "markedScript", "vendor/marked.umd.js", base));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(safeTitle)}">
  <meta property="og:description" content="${escapeHtml(safeDescription)}">
  <meta property="og:image" content="${ogImage}">
  <title>${escapeHtml(safeTitle)} · Relayer</title>
  <link rel="icon" href="${logo}">
  <link rel="stylesheet" href="${workspaceStyles}">
  <link rel="stylesheet" href="${viewerStyles}">
</head>
<body class="public-share-shell">
  <main class="public-share-main">
    <aside class="public-share-download-card" aria-labelledby="publicShareDownloadTitle">
      <div class="public-share-download-copy">
        <img src="${logo}" alt="" width="28" height="28">
        <div>
          <strong id="publicShareDownloadTitle">Relayer for Mac</strong>
          <small>Explore this thread, then build your own.</small>
        </div>
      </div>
      <div class="public-share-download-actions">
        <a class="public-share-primary-action" href="${install}" target="_blank" rel="noopener noreferrer">Download</a>
        <span class="public-share-platform-note">Also for Windows</span>
      </div>
    </aside>
    <section id="publicViewerHost" class="public-share-workspace-host" aria-label="Shared conversation workspace">
      <section class="thread-view" id="threadView"></section>
    </section>
    <section class="public-share-error hidden" id="publicShareError" role="alert" aria-live="assertive">
      <h2>This shared thread couldn’t be loaded</h2>
      <p>The snapshot is unavailable or invalid. Try loading it again.</p>
      <button class="public-share-reload" id="publicShareReload" type="button">Reload</button>
    </section>
  </main>
  <script type="application/json" id="relayerPublicSnapshot">${snapshotLiteral}</script>
  <script src="${lucideScript}"></script>
  <script src="${markedScript}"></script>
  <script type="module" src="${viewerScript}"></script>
</body>
</html>`;
}

export const publicViewerInstallUrl = DEFAULT_INSTALL_URL;
