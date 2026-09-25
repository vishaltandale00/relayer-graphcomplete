const DEFAULT_ASSET_BASE = ".";
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

function safeInstallUrl(value) {
  const url = value == null ? DEFAULT_INSTALL_URL : String(value);
  if (url !== DEFAULT_INSTALL_URL) {
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
  installUrl = DEFAULT_INSTALL_URL,
} = {}) {
  const base = safeAssetBase(assetBase);
  const install = safeInstallUrl(installUrl);
  const safeTitle = String(title || "Shared conversation").slice(0, 120);
  const safeDescription = String(description || DEFAULT_DESCRIPTION).slice(0, 240);
  const snapshotLiteral = safeJsonScriptText(snapshot);
  const csp = escapeHtml(publicViewerCsp());
  const logo = escapeHtml(assetUrl(base, "assets/relayer-logo.svg"));
  const ogImage = escapeHtml(assetUrl(base, "assets/relayer-share-og.svg"));
  const viewerScript = escapeHtml(assetUrl(base, "src/public-share-viewer/main.js"));
  const viewerStyles = escapeHtml(assetUrl(base, "src/public-share-viewer/viewer.css"));
  const workspaceStyles = escapeHtml(assetUrl(base, "styles.css"));
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
  <header class="public-share-topbar">
    <a class="public-share-brand" href="${install}" target="_blank" rel="noopener noreferrer" aria-label="Relayer, open desktop download">
      <img src="${logo}" alt="" width="24" height="24">
      <span>Relayer</span>
    </a>
    <div class="public-share-topbar-meta">
      <span class="public-share-read-only">Read-only snapshot</span>
      <a class="public-share-install-link" href="${install}" target="_blank" rel="noopener noreferrer">Open Relayer</a>
    </div>
  </header>
  <main class="public-share-main">
    <section class="public-share-download-card" aria-labelledby="publicShareDownloadTitle">
      <div>
        <span class="public-share-eyebrow">Relayer for Mac</span>
        <h1 id="publicShareDownloadTitle">Explore this graph in Relayer</h1>
        <p>Open the desktop app to create, inspect, and continue your own local conversations.</p>
      </div>
      <div class="public-share-download-actions">
        <a class="public-share-primary-action" href="${install}" target="_blank" rel="noopener noreferrer">Download</a>
        <span class="public-share-platform-note">Also for Windows</span>
      </div>
    </section>
    <section id="publicViewerHost" class="public-share-workspace-host" aria-label="Shared conversation workspace">
      <section class="thread-view" id="threadView"></section>
    </section>
    <section class="public-share-error hidden" id="publicShareError" role="alert" aria-live="assertive">
      <h2>This shared thread couldn’t be loaded</h2>
      <p>The snapshot is unavailable or invalid. Try loading it again.</p>
      <button class="public-share-reload" id="publicShareReload" type="button">Reload</button>
    </section>
  </main>
  <footer class="public-share-footer"><span>Shared from Relayer</span><span>Read-only · No account required</span></footer>
  <script type="application/json" id="relayerPublicSnapshot">${snapshotLiteral}</script>
  <script type="module" src="${viewerScript}"></script>
</body>
</html>`;
}

export const publicViewerInstallUrl = DEFAULT_INSTALL_URL;
