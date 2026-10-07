// Tidewater ordering app: a tiny dependency-free web app with an API, standing in
// for `npm run dev`. PORT comes from the environment.
import { createServer } from "node:http";

const port = Number(process.env.PORT || 5179);
const orders = [
  { id: 1, name: "Ana", drink: "Harbour Espresso", status: "ready" },
  { id: 2, name: "Ben", drink: "Kelp Cold Brew", status: "brewing" },
];

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tidewater Orders</title>
<style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6efe4;color:#1d2a2a}
header{display:flex;justify-content:space-between;align-items:center;padding:16px 28px;background:#0f6e6a;color:#fff}
main{padding:28px;max-width:760px}
form{display:flex;gap:10px;margin-bottom:22px;flex-wrap:wrap}
input,select,button{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid #d6c9b4}
button{background:#d9783b;color:#241105;border:0;font-weight:700;cursor:pointer}
.order{display:flex;justify-content:space-between;padding:14px 16px;margin-bottom:10px;background:#fff;border-radius:12px;border:1px solid #eadfcd}
.status{font-size:13px;padding:2px 10px;border-radius:999px;background:#cfe8e3;color:#0f6e6a}
.status.brewing{background:#fde3cf;color:#8a3d0b}
.who{color:#5b6b68;font-size:14px}
</style></head><body>
<header><b>Tidewater · Orders</b><span id="barista"></span></header>
<main>
<form id="orderForm"><input id="name" placeholder="Name" required><select id="drink"><option>Harbour Espresso</option><option>Kelp Cold Brew</option><option>Driftwood Flat White</option></select><button>Place order</button></form>
<section id="orders"></section>
</main>
<script>
const barista = localStorage.getItem("tidewater.barista");
document.querySelector("#barista").textContent = barista ? "Signed in as " + barista : "Not signed in";
async function load(){const list=await (await fetch("/api/orders")).json();document.querySelector("#orders").innerHTML=list.map(o=>'<div class="order"><div><b>'+o.drink+'</b><div class="who">for '+o.name+'</div></div><span class="status '+o.status+'">'+o.status+'</span></div>').join("")}
document.querySelector("#orderForm").onsubmit=async e=>{e.preventDefault();await fetch("/api/orders",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:document.querySelector("#name").value,drink:document.querySelector("#drink").value})});document.querySelector("#name").value="";load()};
load();
</script></body></html>`;

createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/api/orders" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(orders));
    return;
  }
  if (url.pathname === "/api/orders" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const order = JSON.parse(body || "{}");
      orders.unshift({ id: orders.length + 1, name: order.name || "Guest", drink: order.drink || "Harbour Espresso", status: "brewing" });
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
    });
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
}).listen(port, "127.0.0.1", () => {
  console.log("> tidewater-orders@0.1.0 dev");
  console.log("compiling routes…");
  setTimeout(() => console.log(`ready - started server on http://localhost:${port}`), 50);
});
