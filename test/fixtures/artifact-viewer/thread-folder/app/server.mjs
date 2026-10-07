// Tidewater order desk: a tiny web app the artifact viewer starts with its server
// invoke (PRD 6.6.6). `node app/server.mjs <port>`; it reads its starting state from
// the "tw_member" cookie and localStorage "tidewater.orders".
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.PORT ?? 41731);
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Order desk</title>
<style>body{margin:0;font:16px system-ui;background:#f3efe6;color:#123}main{max-width:720px;margin:48px auto;padding:0 24px}
h1{font-size:34px;margin:0 0 8px}.card{background:#fff;border-radius:14px;padding:20px 24px;margin:16px 0;box-shadow:0 2px 10px #0001}
button{font:inherit;padding:10px 16px;border:0;border-radius:10px;background:#0f6e6a;color:#fff}</style></head>
<body><main><p>TIDEWATER · ORDER DESK</p><h1>Today's orders</h1><p id="member"></p>
<div class="card"><b id="count"></b><ul id="orders"></ul><button id="add">Add a Harbour Espresso</button></div>
<p id="server"></p></main>
<script>
const read = () => { try { return JSON.parse(localStorage.getItem("tidewater.orders") || "[]"); } catch { return []; } };
const member = document.cookie.split("; ").find((pair) => pair.startsWith("tw_member="))?.split("=")[1];
function render() {
  const orders = read();
  document.querySelector("#count").textContent = orders.length + " open order" + (orders.length === 1 ? "" : "s");
  document.querySelector("#orders").innerHTML = orders.map((order) => "<li>" + order + "</li>").join("");
  document.querySelector("#member").textContent = member ? "Signed in as " + decodeURIComponent(member) : "Not signed in";
}
document.querySelector("#add").onclick = () => { localStorage.setItem("tidewater.orders", JSON.stringify([...read(), "Harbour Espresso"])); render(); };
fetch("/api/status").then((r) => r.json()).then((s) => { document.querySelector("#server").textContent = "Served by process " + s.pid + " since " + s.started; });
render();
</script></body></html>`;
const started = new Date().toISOString();
createServer((request, response) => {
  if (request.url === "/api/status") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pid: process.pid, started }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
}).listen(port, "127.0.0.1", () => console.log(`Order desk listening on http://127.0.0.1:${port}/`));
