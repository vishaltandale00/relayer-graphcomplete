// PROTOTYPE — throwaway (issue #684). Renders the case matrix with live state.
import { CASES, GROUPS } from "./cases.js";
import { FINDINGS } from "./findings.js";

const $ = (selector) => document.querySelector(selector);
const config = await fetch("/proto/config").then((r) => r.json());
const results = await fetch("/proto/captures/results.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const verdicts = (() => { try { return JSON.parse(localStorage.getItem("avMatrixVerdicts") || "{}"); } catch { return {}; } })();
const saveVerdicts = () => { try { localStorage.setItem("avMatrixVerdicts", JSON.stringify(verdicts)); } catch {} };

function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
}

function statusPill(status) {
  const label = { pass: "Pass", fail: "Fail", observe: "Judge", none: "Not run" }[status ?? "none"];
  return h("span", { class: `mx-pill mx-${status ?? "none"}`, text: label });
}

function verdictButtons(id) {
  const wrap = h("div", { class: "mx-verdict" });
  const render = () => {
    wrap.replaceChildren(...[["ok", "✓", "Looks right"], ["no", "✗", "Needs change"], ["q", "?", "Unsure"]].map(([value, glyph, title]) => h("button", {
      type: "button", title, class: verdicts[id] === value ? "on" : "",
      onclick: () => { verdicts[id] = verdicts[id] === value ? undefined : value; saveVerdicts(); render(); renderSummary(); },
    }, glyph)));
  };
  render();
  return wrap;
}

function thumb(file, caption) {
  if (!file) return h("span", { class: "mx-muted", text: "—" });
  const img = h("img", { src: `/proto/captures/${file}`, alt: caption, loading: "lazy" });
  img.onclick = () => {
    const box = $("#lightbox");
    box.querySelector("img").src = img.src;
    box.querySelector("p").textContent = caption;
    box.hidden = false;
  };
  return img;
}
$("#lightbox").onclick = () => { $("#lightbox").hidden = true; };

function row(item) {
  const result = results[item.id];
  return h("tr", { id: item.id },
    h("td", { class: "mx-id", text: item.id }),
    h("td", {}, h("b", { text: item.title }), h("div", { class: "mx-refs", text: item.refs })),
    h("td", { class: "mx-expect", text: item.expect }),
    h("td", { class: "mx-observed" }, statusPill(result?.status), h("p", { text: result?.observed ?? "Run capture-cases.mjs to fill this in." })),
    h("td", { class: "mx-shot" }, thumb(result?.screenshot, `${item.id} · ${item.title}`), result?.screenshotBefore ? thumb(result.screenshotBefore, `${item.id} · before sending`) : null),
    h("td", {}, h("a", { href: item.link, target: "_blank", text: "Open ↗" })),
    h("td", {}, verdictButtons(item.id)));
}

function integrityRows() {
  const expected = { R1: "artifact_path_outside_thread", R2: "artifact_path_outside_thread", R3: "artifact_file_missing", R4: "artifact_type_unsupported", R5: "artifact_path_not_relative", R6: "artifact_url_scheme", R7: "artifact_app_ready_url", R8: "artifact_layer_member_count" };
  return config.rejections.map((rejection) => {
    const ok = rejection.ok === false && rejection.code === expected[rejection.id];
    return h("tr", { id: rejection.id },
      h("td", { class: "mx-id", text: rejection.id }),
      h("td", {}, h("b", { text: rejection.label }), h("div", { class: "mx-refs", text: "D22 D31 · ART-001/002" })),
      h("td", { class: "mx-expect" }, "Rejected at submitNode with ", h("code", { text: expected[rejection.id] }), ". ", h("code", { class: "mx-src", text: JSON.stringify(rejection.artifact.source) })),
      h("td", { class: "mx-observed" }, statusPill(ok ? "pass" : "fail"), h("p", { text: `${rejection.code}: ${rejection.message}` })),
      h("td", { class: "mx-shot" }, h("span", { class: "mx-muted", text: "returned to the agent" })),
      h("td", {}, h("a", { href: "/proto/config", target: "_blank", text: "JSON ↗" })),
      h("td", {}, verdictButtons(rejection.id)));
  });
}

function renderGroups() {
  const host = $("#groups");
  host.replaceChildren();
  for (const [key, title, description] of GROUPS) {
    const items = CASES.filter((item) => item.group === key);
    const section = h("section", { class: "mx-group", id: `group-${key}` }, h("h2", { text: title }), h("p", { class: "mx-muted", text: description }));
    if (key === "o1") {
      section.append(h("div", { class: "mx-variants" }, items.map((item) => {
        const result = results[item.id];
        const pick = h("label", { class: `mx-pick${verdicts.o1Pick === item.id ? " on" : ""}` }, h("input", { type: "radio", name: "o1", checked: verdicts.o1Pick === item.id ? "" : null, onchange: () => { verdicts.o1Pick = item.id; saveVerdicts(); renderGroups(); renderSummary(); } }), " Pick this one");
        return h("article", { class: "mx-variant" }, h("header", {}, h("b", { text: item.title }), h("a", { href: item.link, target: "_blank", text: "Try it ↗" })),
          thumb(result?.screenshot, item.title), h("p", { text: item.expect }), result?.observed ? h("p", { class: "mx-muted", text: result.observed }) : null, pick);
      })));
      const note = h("textarea", { class: "mx-note", rows: "3", placeholder: "What to steal from each variant (e.g. 'drawer from D, but the docked input from A')…" });
      note.value = verdicts.o1Note ?? "";
      note.oninput = () => { verdicts.o1Note = note.value; saveVerdicts(); };
      section.append(note);
      if (results["N4"]) section.append(h("p", { class: "mx-muted" }, "Variant C after Esc: ", thumb(results.N4.screenshot, "C · chips above the thread composer")));
    } else {
      const table = h("table", { class: "mx-table" },
        h("thead", {}, h("tr", {}, ...["", "Case", "Expected (spec)", "Observed", "Screenshot", "", "Your verdict"].map((text) => h("th", { text })))),
        h("tbody", {}, items.map(row), key === "integrity" ? integrityRows() : []));
      section.append(table);
    }
    host.append(section);
  }
}

function renderSummary() {
  const statuses = Object.values(results).filter((r) => r?.status);
  const count = (status) => statuses.filter((r) => r.status === status).length;
  const integrityPass = config.rejections.filter((r) => r.ok === false).length;
  const yours = Object.entries(verdicts).filter(([key, value]) => !key.startsWith("o1") && value);
  $("#summary").replaceChildren(
    h("span", { class: "mx-pill mx-pass", text: `${count("pass") + integrityPass} pass` }),
    h("span", { class: "mx-pill mx-fail", text: `${count("fail")} fail` }),
    h("span", { class: "mx-pill mx-observe", text: `${count("observe")} to judge` }),
    h("span", { class: "mx-muted", text: results.__meta ? `Captured ${new Date(results.__meta.at).toLocaleString()} · ${results.__meta.browser ? `Chrome ${results.__meta.browser}` : ""} · unexpected page errors during run: ${results.__meta.consoleErrors.length} (plus ${results.__meta.expectedErrors ?? 0} provoked by A4)` : "No capture yet." }),
    h("span", { class: "mx-muted", text: `Your verdicts: ${yours.filter(([, v]) => v === "ok").length} ✓ · ${yours.filter(([, v]) => v === "no").length} ✗ · ${yours.filter(([, v]) => v === "q").length} ? · O1 pick: ${verdicts.o1Pick ?? "—"}` }));
  $("#nav").replaceChildren(...GROUPS.map(([key, title]) => h("a", { href: `#group-${key}`, text: title })), h("a", { href: "#findings", text: "Findings" }));
}

async function renderProcesses() {
  const data = await fetch("/proto/processes").then((r) => r.json());
  $("#idleNote").textContent = `Prototype idle stop: ${data.idleMs / 1000} s after the viewer closes (spec: about 1 hour). Approved commands this thread: ${data.approvals.length ? data.approvals.join(", ") : "none"}.`;
  $("#procRows").replaceChildren(...data.processes.map((p) => h("tr", {},
    h("td", { text: p.nodeId.replace("node:", "") }), h("td", {}, h("code", { text: p.command })), h("td", { text: p.startedBy }),
    h("td", {}, h("span", { class: `mx-pill mx-${p.status === "ready" ? "pass" : p.status === "failed" ? "fail" : "none"}`, text: p.status })),
    h("td", { text: p.idleRemainingMs != null ? `${Math.ceil(p.idleRemainingMs / 1000)} s` : p.startedBy === "relayer" ? "—" : "never (not Relayer's)" }),
    h("td", {}, p.startedBy === "relayer" && p.status === "ready" ? h("button", { type: "button", onclick: async () => { await fetch("/proto/stop", { method: "POST", body: JSON.stringify({ nodeId: p.nodeId }) }); renderProcesses(); } }, "Stop") : null))));
}

$("#touchSite").onclick = async () => {
  const status = await fetch("/proto/touch", { method: "POST" }).then((r) => r.json());
  $("#controlNote").textContent = status.matches ? "site/styles.css restored — the landing page matches its accepted fingerprint." : "site/styles.css edited — open the landing page to see 'Changed since this was accepted'.";
};
$("#resetApprovals").onclick = async () => {
  await fetch("/proto/reset-approvals", { method: "POST" });
  $("#controlNote").textContent = "Approvals forgotten — the next app start will ask again.";
  renderProcesses();
};

$("#findings").replaceChildren(h("h2", { text: "What the prototype taught us" }), h("p", { class: "mx-muted", text: "Inputs for the PRD write-up (O3). Each names the cases or decisions it affects." }),
  h("ol", {}, FINDINGS.map(([title, body, refs]) => h("li", {}, h("b", { text: title }), h("span", { class: "mx-refs", text: ` ${refs}` }), h("p", { text: body })))));

renderSummary();
renderGroups();
renderProcesses();
setInterval(renderProcesses, 2000);
if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
