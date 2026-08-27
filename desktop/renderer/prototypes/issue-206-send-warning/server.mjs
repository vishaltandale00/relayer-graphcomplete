import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prototypeDirectory = dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.RELAYER_PROTOTYPE_PORT ?? "4173", 10);

createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/index.html") {
    response.writeHead(404).end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  createReadStream(join(prototypeDirectory, "index.html")).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Issue #206 prototype: http://127.0.0.1:${port}/?variant=B`);
});
