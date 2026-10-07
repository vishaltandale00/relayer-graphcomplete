// Tidewater static site. State lives in browser storage so the artifact viewer
// can seed it: localStorage "tidewater.cart" (JSON list) and cookie "tw_member".
const MENU = [
  ["Harbour Espresso", 4.0], ["Kelp Cold Brew", 5.5], ["Driftwood Flat White", 4.75], ["Low Tide Decaf", 4.0],
];

function readCart() {
  try { return JSON.parse(localStorage.getItem("tidewater.cart") || "[]"); } catch { return []; }
}

function cookie(name) {
  return document.cookie.split("; ").find((pair) => pair.startsWith(`${name}=`))?.split("=")[1] ?? null;
}

function render() {
  const hash = location.hash || "#/";
  const route = hash.startsWith("#/menu") ? "menu" : hash.startsWith("#/cart") ? "cart" : "home";
  for (const main of document.querySelectorAll(".route")) main.hidden = main.id !== `route-${route}`;
  const cart = readCart();
  document.querySelector("#cartCount").textContent = String(cart.length);
  document.querySelector("#menuList").innerHTML = MENU.map(([name, price]) => `<li><span>${name}</span><b>$${price.toFixed(2)}</b></li>`).join("");
  document.querySelector("#cartList").innerHTML = cart.length
    ? cart.map((item) => `<li><span>${item.name} × ${item.qty}</span><b>$${(item.price * item.qty).toFixed(2)}</b></li>`).join("")
    : "<li><span>Your cart is empty.</span></li>";
  const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  document.querySelector("#cartTotal").textContent = cart.length ? `Total $${total.toFixed(2)}` : "";
  const member = cookie("tw_member");
  document.querySelector("#memberGreeting").textContent = member ? `Welcome back, ${decodeURIComponent(member)} — members save 10%.` : "";
  // Anchors inside the home route (e.g. #pricing) still scroll normally.
  if (route === "home" && hash.length > 2 && !hash.startsWith("#/")) document.querySelector(hash)?.scrollIntoView();
}

addEventListener("hashchange", render);
render();
