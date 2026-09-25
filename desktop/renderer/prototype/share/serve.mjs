// PROTOTYPE - throwaway local server for Issue #471 Gate A. Not product code.
// Run: npm run prototype:share
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const exportPath = process.env.RELAYER_SHARE_PROTOTYPE_EXPORT
  || join(homedir(), "Library", "Application Support", "Relayer", "share-prototype", "real-best-model-mix.jsonl");
const port = Number(process.env.PORT || 4390);
const sharesByAttempt = new Map();
const sharesById = new Map();
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function acceptedOnlyExport(jsonl, publicTitle) {
  const [header, ...turns] = String(jsonl).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const accepted = turns
    .filter((turn) => turn.completion?.status === "accepted" && turn.acceptedView)
    .map((turn, index) => ({ ...turn, sequence: index + 1 }));
  const frozenHeader = {
    ...header,
    conversation: {
      ...header.conversation,
      title: publicTitle,
    },
    turns: accepted.map(({ id, sequence }) => ({ id, sequence })),
  };
  return `${[frozenHeader, ...accepted].map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (request.method === "POST" && url.pathname === "/__prototype/shares") {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 17 * 1024 * 1024) throw new Error("prototype request too large");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!input.attemptId || !input.shareId || !String(input.title).trim()
        || String(input.title).length > 120 || !input.sourceJsonl) {
        throw new Error("attemptId, shareId, title, and source snapshot are required");
      }
      let share = sharesByAttempt.get(input.attemptId);
      if (!share) {
        share = Object.freeze({
          attemptId: input.attemptId,
          shareId: input.shareId,
          title: String(input.title),
          jsonl: acceptedOnlyExport(input.sourceJsonl, String(input.title)),
        });
        sharesByAttempt.set(input.attemptId, share);
        sharesById.set(input.shareId, share);
      }
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ shareId: share.shareId, title: share.title }));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Local fake share rejected: ${error.message}`);
    }
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/__prototype/shares/")) {
    const shareId = decodeURIComponent(url.pathname.slice("/__prototype/shares/".length));
    const share = sharesById.get(shareId);
    if (!share) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("This shared thread is unavailable in the in-memory prototype service.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ title: share.title, jsonl: share.jsonl }));
    return;
  }
  if (url.pathname === "/__prototype/export") {
    try {
      const body = await readFile(exportPath);
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch (error) {
      console.error(`Local prototype export unavailable: ${error.message}`);
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Local prototype export unavailable.");
    }
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/share-prototype.html";
  const file = normalize(join(root, pathname));
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(403);
    response.end("forbidden");
    return;
  }
  try {
    let body = await readFile(file);
    if (pathname === "/share-prototype.html" && url.searchParams.get("mode") === "viewer") {
      const share = sharesById.get(url.searchParams.get("id"));
      const publicTitle = share?.title ?? "Shared thread unavailable";
      const description = share
        ? "A frozen, read-only Relayer thread."
        : "This shared Relayer thread is unavailable.";
      body = body.toString("utf8")
        .replace('<meta property="og:title" content="Shared thread · Relayer" />', `<meta property="og:title" content="${escapeHtmlAttribute(publicTitle)}" />`)
        .replace('<meta property="og:description" content="A frozen, read-only Relayer thread." />', `<meta property="og:description" content="${description}" />`)
        .replace("<title>Share slice 1 · Relayer prototype</title>", `<title>${escapeHtmlAttribute(publicTitle)} · Relayer</title>`);
    }
    response.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`share prototype: http://127.0.0.1:${port}/share-prototype.html`);
  console.log(`local export: ${exportPath}`);
});
