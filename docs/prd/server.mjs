import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const prdDirectory = dirname(fileURLToPath(import.meta.url));
const commentsPath = join(prdDirectory, "comments.json");
const portArgument = process.argv.indexOf("--port");
const port = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : 8765;

const emptyComments = () => ({
  schemaVersion: 1,
  document: "docs/prd/index.html",
  updatedAt: null,
  annotations: [],
});

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function sendJson(response, status, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Annotation payload exceeds 1 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleAnnotations(request, response) {
  if (request.method === "GET") {
    try {
      sendJson(response, 200, JSON.parse(await readFile(commentsPath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      sendJson(response, 200, emptyComments());
    }
    return;
  }

  if (request.method === "PUT") {
    const document = JSON.parse(await readRequestBody(request));
    if (document?.schemaVersion !== 1 || document?.document !== "docs/prd/index.html" || !Array.isArray(document?.annotations)) {
      sendJson(response, 400, { error: "Invalid annotation document" });
      return;
    }
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    const temporaryPath = `${commentsPath}.tmp`;
    await mkdir(dirname(commentsPath), { recursive: true });
    await writeFile(temporaryPath, serialized, "utf8");
    await rename(temporaryPath, commentsPath);
    sendJson(response, 200, { saved: true, path: "docs/prd/comments.json" });
    return;
  }

  response.writeHead(405, { allow: "GET, PUT" });
  response.end();
}

async function handleStatic(request, response, pathname) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const normalized = normalize(requested);
  const filePath = join(prdDirectory, normalized);
  if (normalized.startsWith(`..${sep}`) || (filePath !== prdDirectory && !filePath.startsWith(`${prdDirectory}${sep}`))) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
  response.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "content-length": fileStat.size,
    "cache-control": "no-cache",
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/api/prd-annotations") await handleAnnotations(request, response);
    else await handleStatic(request, response, url.pathname);
  } catch (error) {
    if (error instanceof SyntaxError) sendJson(response, 400, { error: "Invalid JSON" });
    else if (error?.code === "ENOENT") {
      response.writeHead(404);
      response.end("Not found");
    } else {
      console.error(error);
      sendJson(response, 500, { error: "Internal server error" });
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Product requirements: http://127.0.0.1:${port}/`);
  console.log("Local comments: docs/prd/comments.json");
});
