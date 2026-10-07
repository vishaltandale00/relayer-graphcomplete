// PROTOTYPE — throwaway (issue #684). Drives every case in the matrix against a
// running prototype server, saves a screenshot per case and records what it saw.
//
//   npm run prototype:artifact-viewer          # in one terminal
//   node scripts/fixtures/artifact-viewer-prototype/capture-cases.mjs
//
// Results land in scripts/fixtures/artifact-viewer-prototype/captures/ and the
// matrix page shows them. Uses Google Chrome when installed (H.264 playback).
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CASES } from "../../../desktop/renderer/artifact-viewer-prototype/cases.js";

const base = process.env.PROTO_URL || "http://127.0.0.1:4684";
const out = resolve(fileURLToPath(new URL("./captures", import.meta.url)));
await mkdir(out, { recursive: true });

const browser = await chromium.launch(existsSync("/Applications/Google Chrome.app") ? { channel: "chrome" } : {});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (error) => consoleErrors.push(String(error)));

const post = (path, body = {}) => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
const config = await fetch(`${base}/proto/config`).then((r) => r.json());
const results = {};
const wait = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__prototype.viewer.state());
const turns = () => page.evaluate(() => window.__prototype.adapter.state.interactions.length);
const badges = () => page.$$eval(".av-badge", (nodes) => nodes.map((n) => n.textContent.trim()).join(" · "));
const artifactFrame = (slug) => page.frames().find((frame) => frame.url().includes(`n-${slug}.localhost`));

async function openCase(link, settle = 2500) {
  await page.goto(`${base}${link}`);
  await page.waitForSelector(".av-overlay", { timeout: 10_000 });
  await wait(settle);
}

async function shot(id) {
  const file = `${id}.jpg`;
  await page.screenshot({ path: join(out, file), type: "jpeg", quality: 62 });
  return file;
}

async function revealToolbar() {
  await page.hover(".av-pinned-address");
  await wait(350);
}

async function annotate(note) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("a");
  await page.waitForSelector(".av-note-panel .av-note-input");
  await page.waitForSelector(".av-note-panel .av-thumb img, .av-note-panel .av-thumb span", { timeout: 20_000 }).catch(() => {});
  await page.fill(".av-note-panel .av-note-input", note);
  await page.keyboard.press("Enter");
  await wait(300);
}
const draftCount = () => page.evaluate(() => window.__prototype.drafts.list().length);

function record(id, status, observed, screenshot) {
  results[id] = { id, status, observed, screenshot, at: new Date().toISOString() };
  process.stdout.write(`${status === "pass" ? "✔" : status === "fail" ? "✘" : "•"} ${id} ${observed}\n`);
}

async function run(id, fn) {
  try {
    await fn();
  } catch (error) {
    let screenshot = null;
    try { screenshot = await shot(id); } catch {}
    record(id, "fail", `Runner error: ${error.message.split("\n")[0]}`, screenshot);
  }
}

const check = (condition, passText, failText) => [condition ? "pass" : "fail", condition ? passText : failText];

// ---------------------------------------------------------------- server invoke first (needs a clean slate)
await post("/proto/reset-approvals");
await post("/proto/stop", { nodeId: "node:art-app" });

await run("S1", async () => {
  await openCase(CASES.find((c) => c.id === "S1").link, 1500);
  const text = await page.textContent(".av-card");
  const [status, observed] = check(text.includes("Run this app?") && text.includes("node ordering-app/server.mjs"), "Approval card names `node ordering-app/server.mjs` in tidewater-launch/; nothing started yet.", `Card text: ${text}`);
  record("S1", status, observed, await shot("S1"));
});
await run("T2", async () => {
  await page.click("text=Allow and run");
  await page.waitForSelector(".av-card h2:has-text('Starting')", { timeout: 5_000 }).catch(() => {});
  results.S2 = { screenshotStarting: await shot("S2-starting") };
  await page.waitForSelector(".av-frame", { timeout: 20_000 });
  await wait(1500);
  const s = await state();
  const badge = await badges();
  const [status, observed] = check(s.server?.status === "ready" && s.server.startedBy === "relayer" && badge.includes("Started by Relayer"), `Server ready (pid ${s.server?.pid}); badge “${badge.trim()}”.`, `Server: ${JSON.stringify(s.server)}`);
  record("T2", status, observed, await shot("T2"));
  record("S2", status, `${observed} Log tail: ${s.server?.log?.slice(-2).join(" / ")}`, results.S2.screenshotStarting);
});
await run("S7", async () => {
  const n = await turns();
  const [status, observed] = check(n === 1, "Thread still has exactly 1 turn after starting the app: the server invoke left no graph record.", `Turns: ${n}`);
  record("S7", status, observed, await shot("S7"));
});
await run("S3", async () => {
  await openCase(CASES.find((c) => c.id === "S3").link, 2500);
  const approval = await page.$("text=Run this app?");
  const s = await state();
  const [status, observed] = check(!approval && s.server?.status === "ready", "Reopened: loaded at once, no approval card, same server.", `Server: ${s.server?.status}, approval shown: ${Boolean(approval)}`);
  record("S3", status, observed, await shot("S3"));
});
await run("S4", async () => {
  await openCase(CASES.find((c) => c.id === "S4").link, 3000);
  const s = await state();
  const badge = await badges();
  const [status, observed] = check(s.server?.startedBy === "agent" && badge.includes("agent left running"), `Reused the agent's server; badge “${badge.trim()}”. Tablet frame.`, `Server: ${JSON.stringify(s.server)}`);
  record("S4", status, observed, await shot("S4"));
});
await run("S5", async () => {
  await openCase(CASES.find((c) => c.id === "S5").link, 800);
  const allow = await page.$("text=Allow and run");
  if (allow) await allow.click();
  await page.waitForSelector(".av-card-error", { timeout: 15_000 });
  const text = await page.textContent(".av-card-error");
  const [status, observed] = check(text.includes("failed to start") && text.includes("ERR_MODULE_NOT_FOUND") && text.includes("Retry"), "Failure card with the npm error, Retry and Add log to chat.", `Card: ${text.slice(0, 200)}`);
  record("S5", status, observed, await shot("S5"));
});
const appLeftAt = Date.now();

// ---------------------------------------------------------------- content types
const simple = {
  T1: async () => {
    const frame = artifactFrame("art-site");
    const heading = await frame.textContent("h1");
    const address = await page.textContent(".av-pinned-address .av-address-text");
    return check(heading.includes("Coffee that tastes") && address.includes("tidewater-launch/site/"), `Live site (“${heading}”); address ${address}.`, `heading ${heading}; address ${address}`);
  },
  T3: async () => {
    const address = await page.textContent(".av-pinned-address .av-address-text");
    const frame = page.frames().find((f) => f.url().startsWith("https://example.com"));
    const heading = frame ? await frame.textContent("h1", { timeout: 3_000 }).catch((error) => `(frame present; ${error.message.split("\n")[0]})`) : null;
    return check(address.startsWith("https://example.com") && Boolean(heading), `Loaded ${address} live (“${heading}”).`, `address ${address}; heading ${heading} (offline?)`);
  },
  T4: async () => { const s = await state(); return check(s.location.label === "Page 1 of 5", `Location “${s.location.label}”.`, `Location “${s.location.label}”.`); },
  T5: async () => {
    const frame = artifactFrame("art-video");
    const info = await frame.evaluate(() => { const v = document.querySelector("video"); return { d: v.duration, rs: v.readyState, err: v.error?.message }; });
    return check(info.d > 19 && !info.err, `WebM decoded: ${info.d}s, readyState ${info.rs}.`, JSON.stringify(info));
  },
  T6: async () => {
    const frame = artifactFrame("art-hero");
    const size = await frame.evaluate(() => [document.querySelector("img").naturalWidth, document.querySelector("img").naturalHeight]);
    return check(size[0] === 1600, `PNG ${size.join("×")} fitted to the screen.`, `size ${size}`);
  },
  T7: async () => {
    const frame = artifactFrame("art-logo");
    const ok = await frame.evaluate(() => document.querySelector("img").naturalWidth > 0);
    return check(ok, "SVG logo rendered.", "SVG did not load.");
  },
  T8: async () => {
    const frame = artifactFrame("art-guide");
    const headings = await frame.evaluate(() => [...document.querySelectorAll("h2")].map((h) => h.textContent));
    return check(headings.includes("Colour"), `Rendered sections: ${headings.join(", ")}.`, `headings ${headings}`);
  },
  T9: async () => {
    const frame = artifactFrame("art-docx");
    const text = await frame.evaluate(() => document.body.innerText);
    return check(text.includes("Wholesale proposal") && text.includes("Harbour Espresso"), "docx-preview rendered the title, bullets and pricing table.", text.slice(0, 120));
  },
  T10: async () => {
    const frame = artifactFrame("art-xlsx");
    const text = await frame.evaluate(() => document.querySelector("#sheet").innerText);
    const hasChart = await frame.evaluate(() => Boolean(document.querySelector("svg, canvas")));
    const totals = await frame.evaluate(() => [...document.querySelectorAll("#sheet tr")].at(-1)?.innerText.replace(/\s+/g, " ").trim());
    return check(text.includes("Green beans"), `SheetJS rendered the Budget values${hasChart ? " and a chart" : "; the workbook's bar chart is not rendered (expected loss)"}. Total row reads “${totals}” — the openpyxl formulas have no cached results, so totals are blank (finding).`, text.slice(0, 120));
  },
  T11: async () => {
    const frame = artifactFrame("art-pptx");
    await frame.evaluate(() => document.querySelector(".pptx-preview-slide-wrapper-2")?.scrollIntoView());
    await wait(600);
    const info = await frame.evaluate(() => ({ text: document.body.innerText, slides: document.querySelectorAll(".pptx-preview-slide-wrapper").length }));
    if (!info.text.includes("Tidewater")) return ["fail", `Deck did not render: ${info.text.slice(0, 120)}`];
    // The chart slide is the fidelity question: python-pptx column chart, values 420–1240.
    const placeholderTitle = info.text.includes("图表标题");
    return ["observe", `${info.slides} slides render (text, titles, bullets). Chart slide: axes and categories draw but no bars, and pptx-preview adds its own Chinese default title “图表标题” ('Chart title')${placeholderTitle ? "" : " (not seen this run)"}. Judge from the screenshot — this is the fidelity risk in D10b.`];
  },
  P1: async () => { const s = await state(); return check(s.location.label === "Page 4 of 5", `Opened on “${s.location.label}”.`, `Location ${s.location.label}`); },
  P2: async () => {
    const frame = artifactFrame("art-video-ship");
    const t = await frame.evaluate(() => document.querySelector("video").currentTime);
    return check(Math.abs(t - 10) < 0.5, `Video positioned at ${t.toFixed(1)}s (segment 0:10–0:15).`, `currentTime ${t}`);
  },
  P3: async () => { const s = await state(); return check(s.location.label === "Section: Colour", `Opened at “${s.location.label}”.`, `Location ${s.location.label}`); },
  P4: async () => {
    const size = await page.evaluate(() => { const f = document.querySelector(".av-frame"); return [f.clientWidth, f.clientHeight]; });
    return check(size[0] === 390, `Phone frame ${size.join("×")} (height capped to the window) at #pricing.`, `frame ${size}`);
  },
  P5: async () => {
    const frame = artifactFrame("art-site-cart");
    const text = await frame.textContent("#route-cart");
    return check(text.includes("Welcome back, Maya") && text.includes("Total $13.50"), "Seeded cart: 2 items, $13.50, member greeting from the cookie.", text.slice(0, 160));
  },
  A1: async () => { const badge = await badges(); return check(badge.includes("Changed since this was accepted"), `Badge: “${badge.trim()}”.`, `Badges: ${badge}`); },
  A3: async () => { const text = await page.textContent(".av-card"); return check(text.includes("no longer in the thread folder"), "Missing-file card with Add to chat; no agent turn started.", text.slice(0, 160)); },
  A4: async () => { const badge = await badges(); const s = await state(); return check(badge.includes("page error"), `Badge “${badge.trim()}”: ${s.errors[0]}`, `Badges: ${badge}`); },
  A5: async () => { const badge = await badges(); return check(!badge.includes("Changed since"), "No fingerprint badge for a URL.", `Badges: ${badge}`); },
  V6: async () => {
    const text = await page.evaluate(() => document.querySelector(".av-overlay").innerText);
    return check(!text.includes("A static site in"), "Only the artifact and the toolbar; the node's description is not shown.", "Description text found in the viewer.");
  },
};
const settleFor = { T3: 4000, T4: 3500, T9: 5000, T10: 5000, T11: 7000, P1: 3500, T5: 3000, P2: 3000 };
for (const [id, fn] of Object.entries(simple)) {
  await run(id, async () => {
    await openCase(CASES.find((c) => c.id === id).link, settleFor[id] ?? 2500);
    const [status, observed] = await fn();
    record(id, status, observed, await shot(id));
  });
}

await run("P6", async () => {
  await openCase(CASES.find((c) => c.id === "P6").link, 2500);
  await artifactFrame("art-site-cart").evaluate(() => { localStorage.setItem("tidewater.cart", "[]"); location.hash = "#/cart?emptied"; dispatchEvent(new HashChangeEvent("hashchange")); });
  await wait(400);
  const emptied = await artifactFrame("art-site-cart").textContent("#cartList");
  await page.keyboard.press("Escape");
  await page.goto(`${base}/artifact-viewer.prototype.html?open=layer:art-site-cart`);
  await page.waitForSelector(".av-frame");
  await wait(2500);
  const again = await artifactFrame("art-site-cart").textContent("#route-cart");
  const [status, observed] = check(emptied.includes("empty") && again.includes("Total $13.50"), "Emptied the cart inside the artifact; reopening reset it to the seed (2 items, $13.50).", `emptied: ${emptied}; reopened: ${again.slice(0, 80)}`);
  record("P6", status, observed, await shot("P6"));
});

await run("P7", async () => {
  await openCase(CASES.find((c) => c.id === "P7").link, 2500);
  const frame = artifactFrame("art-site");
  const probe = await frame.evaluate(async (origin) => {
    const api = await fetch(`${origin}/proto/config`, { credentials: "include" }).then(() => "read", (error) => `blocked (${error.name})`);
    let parentDom;
    try { parentDom = parent.document.title; } catch (error) { parentDom = `blocked (${error.name})`; }
    return { api, parentDom, otherArtifactCart: localStorage.getItem("tidewater.cart"), origin: location.origin };
  }, base);
  const ok = probe.api.startsWith("blocked") && probe.parentDom.startsWith("blocked") && probe.otherArtifactCart === null;
  const [status, observed] = check(ok, `From ${probe.origin}: Relayer API ${probe.api}; parent DOM ${probe.parentDom}; the cart seeded for another artifact is not visible here.`, JSON.stringify(probe));
  record("P7", status, observed, await shot("P7"));
});

await run("V1", async () => {
  await openCase(CASES.find((c) => c.id === "V1").link, 3600);
  const hidden = await page.evaluate(() => document.querySelector(".av-overlay").classList.contains("av-toolbar-hidden"));
  const strip = await page.isVisible(".av-pinned-address");
  const shotHidden = await shot("V1");
  await revealToolbar();
  const shown = await page.evaluate(() => !document.querySelector(".av-overlay").classList.contains("av-toolbar-hidden"));
  await shot("V1-shown");
  const [status, observed] = check(hidden && strip && shown, "Toolbar hid after ~2.6 s; address strip stayed; hovering the strip brought the toolbar back.", `hidden ${hidden}, strip ${strip}, shown ${shown}`);
  record("V1", status, observed, shotHidden);
});
await run("V2", async () => {
  await openCase(CASES.find((c) => c.id === "V2").link, 1500);
  await revealToolbar();
  const labels = await page.$$eval(".av-toolbar > button, .av-toolbar > .av-menu-wrap > button", (buttons) => buttons.map((b) => b.getAttribute("aria-label") || b.textContent.trim()));
  const file = await shot("V2");
  const [status, observed] = check(!labels.some((l) => /Actions|references/i.test(l)), `Top bar buttons: ${labels.join(" · ")}. No actions or references.`, `buttons ${labels}`);
  record("V2", status, observed, file);
});
await run("V4", async () => {
  await openCase(CASES.find((c) => c.id === "V4").link, 1500);
  await page.keyboard.press("Escape");
  await wait(600);
  const closed = await page.evaluate(() => document.querySelector("#artifactViewerRoot").hidden);
  const [status, observed] = check(closed, "One Esc returned to the graph.", `closed ${closed}`);
  record("V4", status, observed, await shot("V4"));
});
await run("V3", async () => {
  await page.goto(`${base}/artifact-viewer.prototype.html`);
  await page.waitForSelector(".graph-node");
  await wait(800);
  await page.click(".graph-node:has-text('Landing page')");
  await wait(800);
  const pills = await page.$$eval("#inspector button, #inspector [role=button]", (nodes) => nodes.map((n) => n.textContent.trim()).filter(Boolean));
  const wanted = ["Open the site", "Pricing on a phone", "Cart as a member"];
  const [status, observed] = check(wanted.every((w) => pills.some((p) => p.includes(w))), `Node Details for Landing page offer: ${wanted.join(" · ")}.`, `inspector buttons: ${pills.join(" | ")}`);
  record("V3", status, observed, await shot("V3"));
});
await run("V5", async () => {
  await openCase(CASES.find((c) => c.id === "V5").link, 2500);
  const frame = artifactFrame("art-site");
  const popupPromise = page.waitForEvent("popup", { timeout: 3_000 }).catch(() => null);
  // Playwright's synthetic pointer misses the bottom ~80 px of a cross-origin frame in this
  // layout; a real pointer works (checked by hand in the in-app browser), so dispatch the click in-page.
  await frame.$eval("#instagram", (link) => link.click());
  const popup = await popupPromise;
  await popup?.close();
  await wait(300);
  const popupUrl = (await state()).externalOpens.at(-1);
  const stillSite = artifactFrame("art-site") != null;
  const file = await shot("V5");
  const [status, observed] = check(Boolean(popupUrl) && stillSite, `The artifact stayed put; ${popupUrl} opened outside (in Relayer: the user's browser).`, `popup ${popupUrl}; frame still on site: ${stillSite}`);
  record("V5", status, observed, file);
});

await run("A2", async () => {
  const edited = await post("/proto/touch");
  await openCase(CASES.find((c) => c.id === "A2").link, 2000);
  const badge = await badges();
  const file = await shot("A2");
  const restored = await post("/proto/touch");
  const [status, observed] = check(edited.matches === false && badge.includes("Changed since") && restored.matches === true, "Editing site/styles.css flipped the landing page to 'Changed since this was accepted'; undoing the edit cleared it.", `edited ${edited.matches}; badge ${badge}; restored ${restored.matches}`);
  record("A2", status, observed, file);
});

// ---------------------------------------------------------------- annotations
await run("N1", async () => {
  await openCase(CASES.find((c) => c.id === "N1").link, 2500);
  await page.keyboard.press("a");
  await page.waitForSelector(".av-note-panel .av-thumb img", { timeout: 20_000 });
  await page.fill(".av-note-panel .av-note-input", "Show the member discount as its own line");
  const where = await page.textContent(".av-note-panel .av-annotate-head b");
  const file = await shot("N1");
  await page.keyboard.press("Enter");
  await wait(300);
  const chips = await draftCount();
  const [status, observed] = check(where.includes("/#/cart") && chips === 1, `Popover captured “${where}” with a screenshot; Enter added 1 chip.`, `where ${where}; chips ${chips}`);
  record("N1", status, observed, file);
});
await run("N2", async () => {
  await openCase(CASES.find((c) => c.id === "N2").link, 3500);
  await annotate("Split the funds bar into labelled segments");
  await page.goto(`${base}/artifact-viewer.prototype.html?open=layer:art-video-ship`);
  await page.waitForSelector(".av-frame");
  await wait(3000);
  await annotate("Hold the Ship title a beat longer");
  const chips = await page.evaluate(() => window.__prototype.drafts.list().map((item) => item.location));
  const [status, observed] = check(chips.some((c) => c.includes("At 0:10")), `Video note location: ${chips.join(" | ")}. (The PDF note recorded 'Page 4 of 5' before the page reload cleared drafts.)`, `chips ${chips}`);
  record("N2", status, observed, await shot("N2"));
});
await run("N3", async () => {
  await openCase(CASES.find((c) => c.id === "N3").link, 2500);
  await annotate("Hero headline is great — keep it");
  await artifactFrame("art-site").evaluate(() => document.querySelector("#pricing").scrollIntoView());
  await wait(800);
  await annotate("Make the Regular plan button say 'Start subscription'");
  await page.fill(".av-docked .av-chat-text", "Two tweaks before launch");
  const before = await shot("N3-before");
  await page.keyboard.press("Enter");
  await wait(600);
  await page.keyboard.press("Escape");
  await wait(800);
  const info = await page.evaluate(() => {
    const interactions = window.__prototype.adapter.state.interactions;
    const last = interactions.at(-1);
    return { turns: interactions.length, text: last.text, contexts: last.contexts.map((c) => ({ node: c.targetNode.id, annotations: c.annotations.length })) };
  });
  const [status, observed] = check(info.turns === 2 && info.contexts[0]?.node === "node:art-site" && info.contexts[0].annotations === 2, `One interaction (turn ${info.turns}) “${info.text}” with the artifact node as context and 2 annotations.`, JSON.stringify(info));
  record("N3", status, observed, await shot("N3"));
  results.N3.screenshotBefore = before;
});
await run("N5", async () => {
  await openCase(CASES.find((c) => c.id === "N5").link, 1500);
  const disabled = await page.$eval(".av-docked .send-button", (button) => button.disabled);
  await page.click(".av-docked .send-button");
  await wait(300);
  const n = await turns();
  const [status, observed] = check(!disabled && n === 1, "Send is enabled with an empty draft; clicking it did nothing.", `disabled ${disabled}; turns ${n}`);
  record("N5", status, observed, await shot("N5"));
});

// ---------------------------------------------------------------- surfaces
for (const id of ["X1", "X2", "X3"]) {
  await run(id, async () => {
    await openCase(CASES.find((c) => c.id === id).link, id === "X2" ? 4000 : 1500);
    const card = await page.$(".av-card");
    const annotate = await page.$(".av-annotate");
    const text = card ? await card.textContent() : "";
    const [status, observed] = id === "X2"
      ? check(!card && !annotate && page.frames().some((f) => f.url().startsWith("https://example.com")), "The https deployment plays live; no Annotate in a read-only surface.", `card ${Boolean(card)}`)
      : await (async () => {
        const address = await page.textContent(".av-pinned-address .av-address-text");
        const external = await page.$("button:has-text('Open externally')");
        return check(text.includes("Available in Relayer on the machine that made it") && !annotate && !external && !address.includes("tidewater-launch"), `Card: “Available in Relayer on the machine that made it”. No Annotate, no Open externally; the address shows “${address}”, not the local folder.`, `${text.slice(0, 120)} · address ${address} · external ${Boolean(external)}`);
      })();
    record(id, status, observed, await shot(id));
  });
}

// ---------------------------------------------------------------- Q3 Annotate options
for (const mode of ["a", "b"]) {
  const id = `Q3-${mode}`;
  await run(id, async () => {
    await openCase(CASES.find((c) => c.id === id).link, 2500);
    const frame = artifactFrame("art-video");
    await frame.evaluate(() => { const v = document.querySelector("video"); v.muted = true; v.currentTime = 6; return v.play(); });
    await wait(1200);
    await annotate("Roast title feels rushed — hold it a beat longer");
    await frame.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 11.5; return v.play(); });
    await wait(900);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("a");
    await page.waitForSelector(".av-note-panel .av-thumb img", { timeout: 20_000 }).catch(() => {});
    await page.fill(".av-note-panel .av-note-input", "Ship chapter: show the courier bike here");
    await wait(300);
    const paused = await frame.evaluate(() => document.querySelector("video").paused);
    const listed = await page.$$eval(".av-note-panel .av-note-row", (rows) => rows.length);
    const file = await shot(id);
    await page.keyboard.press("Escape");
    await wait(700);
    const resumed = await frame.evaluate(() => !document.querySelector("video").paused);
    const [status, observed] = check(paused && listed === 1 && resumed, `While the panel was open the video was paused; it resumed after Esc. The earlier note is listed in the panel with ×.`, `paused ${paused}; listed ${listed}; resumed ${resumed}`);
    record(id, status === "pass" ? "observe" : status, status === "pass" ? `${observed} Judge the look from the screenshot.` : observed, file);
  });
}
for (const mode of ["d", "e"]) {
  const id = `Q3-${mode}`;
  await run(id, async () => {
    await openCase(CASES.find((c) => c.id === id).link, 2500);
    const frame = artifactFrame("art-video");
    await frame.evaluate(() => { const v = document.querySelector("video"); v.muted = true; v.currentTime = 6; return v.play(); });
    await wait(1200);
    const field = mode === "d" ? ".av-inline-input" : ".av-strip-input";
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("a");
    await page.waitForSelector(field);
    await page.fill(field, "Roast title feels rushed — hold it a beat longer");
    await page.waitForSelector(".av-cam.av-captured", { timeout: 20_000 }).catch(() => {});
    await page.keyboard.press("Enter");
    await wait(400);
    await frame.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 11.5; return v.play(); });
    await wait(900);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("a");
    await page.waitForSelector(field);
    await page.fill(field, "Ship chapter: show the courier bike here");
    await page.waitForSelector(".av-cam.av-captured", { timeout: 20_000 }).catch(() => {});
    const paused = await frame.evaluate(() => document.querySelector("video").paused);
    const file = await shot(id);
    await page.click(".av-notes-chip");
    await wait(300);
    const listFile = await shot(`${id}-list`);
    await page.keyboard.press("Escape");
    await wait(700);
    const resumed = await frame.evaluate(() => !document.querySelector("video").paused);
    const notes = await page.evaluate(() => window.__prototype.drafts.list().map((item) => ({ location: item.location, shot: Boolean(item.screenshot) })));
    const [status, observed] = check(paused && resumed && notes.length === 1 && notes[0].shot, `Video paused while writing and resumed after Esc; the first note kept its silent screenshot (${notes[0]?.location}).`, `paused ${paused}; resumed ${resumed}; notes ${JSON.stringify(notes)}`);
    record(id, status === "pass" ? "observe" : status, status === "pass" ? `${observed} Judge the look from the screenshot.` : observed, file);
    results[id].screenshotBefore = listFile;
  });
}
await run("Q3-f", async () => {
  await openCase(CASES.find((c) => c.id === "Q3-f").link, 2500);
  const frameBox = await page.$eval(".av-frame", (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  const cta = await artifactFrame("art-site").$eval("a.cta", (node) => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("a");
  await page.waitForSelector(".av-pin-layer");
  await page.mouse.click(frameBox.x + 420, frameBox.y + 300);
  await page.fill(".av-pin-input", "Headline could be one line on desktop");
  await page.waitForSelector(".av-cam.av-captured", { timeout: 20_000 }).catch(() => {});
  await page.keyboard.press("Enter");
  await wait(400);
  await page.keyboard.press("a");
  await page.waitForSelector(".av-pin-layer");
  await page.mouse.click(frameBox.x + cta.x, frameBox.y + cta.y);
  await page.fill(".av-pin-input", "Make this the only filled button");
  await page.waitForSelector(".av-cam.av-captured", { timeout: 20_000 }).catch(() => {});
  await page.hover(".av-pin-old");
  await wait(250);
  const file = await shot("Q3-f");
  await page.keyboard.press("Enter");
  await wait(300);
  const items = await page.evaluate(() => window.__prototype.drafts.list().map((item) => ({ point: item.point, shot: Boolean(item.screenshot) })));
  const [status, observed] = check(items.length === 2 && items.every((item) => item.point && item.shot), `Two pinned notes with points ${items.map((i) => JSON.stringify(i.point)).join(", ")}; each has a cropped screenshot with the spot marked.`, JSON.stringify(items));
  record("Q3-f", status === "pass" ? "observe" : status, status === "pass" ? `${observed} Judge the look from the screenshot (the earlier pin's tooltip is shown on hover).` : observed, file);
});
await run("Q3-c", async () => {
  await openCase(CASES.find((c) => c.id === "Q3-c").link, 2500);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("a");
  await page.waitForSelector(".av-box-layer");
  const hint = await shot("Q3-c-hint");
  const button = await artifactFrame("art-site").$eval("a.cta", (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const frameBox = await page.$eval(".av-frame", (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y }; });
  const x0 = frameBox.x + button.x - 14, y0 = frameBox.y + button.y - 12;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + button.w + 160, y0 + button.h + 24, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector(".av-note-panel .av-thumb img", { timeout: 20_000 }).catch(() => {});
  await page.fill(".av-note-panel .av-note-input", "These two buttons compete — make 'See the menu' the only filled one");
  await wait(300);
  const file = await shot("Q3-c");
  await page.keyboard.press("Enter");
  await wait(300);
  const item = await page.evaluate(() => window.__prototype.drafts.list().at(-1));
  const [status, observed] = check(Boolean(item?.box) && item.location.includes("marked area"), `Dragged a box around the hero buttons; the note stored the box (${JSON.stringify(item?.box)}) and a cropped, outlined screenshot.`, JSON.stringify(item));
  record("Q3-c", status === "pass" ? "observe" : status, status === "pass" ? `${observed} Judge the look from the screenshot.` : observed, file);
  results["Q3-c"].screenshotBefore = hint;
});

// ---------------------------------------------------------------- O1 variants (two notes each)
for (const variant of ["A", "B", "C", "D"]) {
  const id = `O1-${variant}`;
  await run(id, async () => {
    await openCase(CASES.find((c) => c.id === id).link, 2500);
    await annotate("Hero headline is great — keep it");
    await artifactFrame("art-site").evaluate(() => document.querySelector("#pricing").scrollIntoView());
    await wait(800);
    await annotate("Make the Regular plan button say 'Start subscription'");
    if (variant === "B" && !(await page.$(".av-floating"))) await page.click(".av-bubble");
    await wait(400);
    const file = await shot(id);
    let extra = "";
    if (variant === "C") {
      await page.keyboard.press("Escape");
      await wait(800);
      const mirrored = await page.$$eval(".av-main-tray .av-chip", (nodes) => nodes.length);
      results["N4"] = { id: "N4", status: mirrored === 2 ? "pass" : "fail", observed: `After Esc, ${mirrored} chips sit above the thread composer; Enter there sends them.`, screenshot: await shot("N4"), at: new Date().toISOString() };
      extra = ` After Esc: ${mirrored} chips above the thread composer.`;
    }
    record(id, "observe", `Two notes added.${extra} Judge the layout from the screenshot.`, file);
  });
}

// ---------------------------------------------------------------- idle stop (needs the idle window to pass)
await run("S6", async () => {
  const remaining = config.idleMs + 4_000 - (Date.now() - appLeftAt);
  if (remaining > 0) { process.stdout.write(`… waiting ${Math.round(remaining / 1000)} s for the idle stop\n`); await wait(remaining); }
  const processes = await fetch(`${base}/proto/processes`).then((r) => r.json());
  const app = processes.processes.find((p) => p.nodeId === "node:art-app");
  const kitchen = processes.processes.find((p) => p.nodeId === "node:art-kitchen");
  await page.goto(`${base}/artifact-viewer-matrix.prototype.html#processes`);
  await wait(1500);
  const [status, observed] = check(app?.status === "stopped" && kitchen?.status === "ready", `Ordering app (started by Relayer) stopped after ${config.idleMs / 1000} s idle; kitchen display (agent's) still running.`, `app ${app?.status}; kitchen ${kitchen?.status}`);
  record("S6", status, observed, await shot("S6"));
});

results.I0 = { id: "I0", status: config.submission.every((s) => s.ok) ? "pass" : "fail", observed: `${config.submission.filter((s) => s.ok).length}/${config.submission.length} fixture artifact nodes pass the submission rules.`, at: new Date().toISOString() };
// The menu board (A4) throws on purpose; anything else is unexpected.
const unexpectedErrors = consoleErrors.filter((message) => !message.includes("reading 'map'"));
results.__meta = { at: new Date().toISOString(), browser: browser.version(), consoleErrors: unexpectedErrors, expectedErrors: consoleErrors.length - unexpectedErrors.length, rejections: config.rejections };
await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2));
await browser.close();
const values = Object.values(results).filter((r) => r.status);
process.stdout.write(`\n${values.filter((r) => r.status === "pass").length} pass · ${values.filter((r) => r.status === "fail").length} fail · ${values.filter((r) => r.status === "observe").length} to judge\n`);
