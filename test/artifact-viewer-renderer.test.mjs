// Artifact viewer chrome (PRD 6.6, ART-006 and ART-008) on the production renderer module.
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { artifactAddress, artifactLayerNode, artifactNoteLabel, artifactNoteText, createArtifactViewer } from "../desktop/renderer/src/artifact-viewer.js";

const site = { kind: "website", source: { file: "site/index.html", root: "site" }, part: { route: "#pricing" }, fingerprint: "sha256:a" };
const node = (artifact, title = "Landing page") => ({ id: 27, icon: "globe", title, detail: "The whole site.", artifact });
let window;

beforeEach(() => {
  window = new Window();
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await window.happyDOM.close();
});

function fakeNative(status = { state: "ok" }) {
  let listener = () => {};
  return {
    open: vi.fn(async () => ({ status })),
    setBounds: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    showMenu: vi.fn(async () => {}),
    beginNote: vi.fn(async () => ({ location: "at 0:12", digest: "c".repeat(64), screenshot: "data:image/png;base64,AAAA" })),
    endNote: vi.fn(async () => {}),
    onEvent: (callback) => { listener = callback; return () => { listener = () => {}; }; },
    emit: (event) => listener(event),
  };
}

const text = (selector) => document.querySelector(selector)?.textContent ?? null;

describe("artifact layers", () => {
  it("open only a layer whose renderer is artifact and whose node has artifact details", () => {
    expect(artifactLayerNode({ layer: { renderer: "artifact" }, nodes: [node(site)] })?.id).toBe(27);
    expect(artifactLayerNode({ layer: {}, nodes: [node(site)] })).toBe(null);
    expect(artifactLayerNode({ layer: { renderer: "artifact" }, nodes: [{ id: 2 }] })).toBe(null);
  });

  it("address the file and the part shown", () => {
    expect(artifactAddress(site)).toBe("site/index.html#pricing");
    expect(artifactAddress({ kind: "pdf", source: { file: "docs/brief.pdf" }, part: { page: 4 } })).toBe("docs/brief.pdf · page 4");
    expect(artifactAddress({ kind: "pptx", source: { file: "docs/pitch.pptx" }, part: { slide: 3 } })).toBe("docs/pitch.pptx · slide 3");
    expect(artifactAddress({ kind: "video", source: { file: "media/promo.mp4" }, part: { start: 10, end: 75 } })).toBe("media/promo.mp4 · 0:10–1:15");
    expect(artifactAddress({ kind: "markdown", source: { file: "docs/guide.md" }, part: { heading: "Colour" } })).toBe("docs/guide.md · Colour");
    expect(artifactAddress({ kind: "url", source: { url: "https://example.com/" } })).toBe("https://example.com/");
  });
});

describe("the desktop viewer (ART-006)", () => {
  it("shows the address, Graph and ⋯ only, and returns to the graph on Esc", async () => {
    const native = fakeNative();
    const onClose = vi.fn();
    const viewer = createArtifactViewer({ root: document.body, native, onClose });
    await viewer.open({ threadId: 1, node: node(site) });
    expect(native.open).toHaveBeenCalledWith(expect.objectContaining({ threadId: 1, nodeId: 27, artifact: site }));
    expect(text(".artifact-strip-text")).toBe("site/index.html#pricing");
    const tools = [...document.querySelectorAll(".artifact-toolbar button")].map((button) => button.getAttribute("aria-label") || button.textContent.trim());
    expect(tools).toEqual(["Graph", "More"]);
    expect(document.body.textContent).not.toContain("The whole site.");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(viewer.isOpen()).toBe(false);
    expect(native.close).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps a file's address when its viewer page navigates, and follows a site", async () => {
    const native = fakeNative();
    const viewer = createArtifactViewer({ root: document.body, native });
    await viewer.open({ threadId: 1, node: node({ kind: "markdown", source: { file: "docs/guide.md" }, part: { heading: "Colour" }, fingerprint: "sha256:a" }) });
    native.emit({ type: "address", url: "relayer-artifact://view/__relayer/view?kind=markdown&file=guide.md" });
    expect(text(".artifact-strip-text")).toBe("docs/guide.md · Colour");
    await viewer.open({ threadId: 1, node: node(site) });
    native.emit({ type: "address", url: "relayer-artifact://view/menu.html" });
    expect(text(".artifact-strip-text")).toBe("site/menu.html");
  });

  it("badges page errors and drift, and offers Add to chat for a missing file", async () => {
    const native = fakeNative({ state: "changed" });
    const onAddToChat = vi.fn();
    const viewer = createArtifactViewer({ root: document.body, native, onAddToChat });
    await viewer.open({ threadId: 1, node: node(site) });
    expect(text('[data-badge="changed"]')).toBe("Changed since this was accepted");
    native.emit({ type: "page-error", message: "TypeError: specials is undefined" });
    expect(text('[data-badge="errors"]')).toBe("1 page error");
    document.querySelector('[data-badge="errors"]').click();
    expect(onAddToChat).toHaveBeenLastCalledWith(expect.stringContaining("TypeError: specials is undefined"));

    native.open.mockResolvedValueOnce({ status: { state: "missing" } });
    await viewer.open({ threadId: 1, node: node(site) });
    expect(text(".artifact-card h2")).toBe("This file is no longer in the thread folder");
    expect(document.querySelector(".artifact-card").textContent).not.toContain("null");
    document.querySelector(".artifact-card-action").click();
    expect(onAddToChat).toHaveBeenLastCalledWith(expect.stringContaining("is no longer in the thread folder"));
    expect(viewer.isOpen()).toBe(false);
  });
});

describe("web apps (ART-009)", () => {
  const app = { kind: "app", source: { url: "http://127.0.0.1:5173/" }, server: { command: "npm run dev" } };

  it("asks before the first run, then opens with the user's approval", async () => {
    const native = fakeNative({ state: "approval-required", command: "npm run dev", permissionProfileId: "auto" });
    const notes = { list: vi.fn(async () => []), add: vi.fn(), remove: vi.fn() };
    const viewer = createArtifactViewer({ root: document.body, native, notes });
    const target = { nodeId: 27, sourceInteractionNodeId: 5, sourceLayerId: 9 };
    await viewer.open({ threadId: 1, node: node(app, "Order desk"), target });
    expect(text(".artifact-card h2")).toBe("Start this web app?");
    expect(text(".artifact-card-command")).toBe("npm run dev");
    expect(text(".artifact-card-note")).toContain("only inside the thread folder");
    native.open.mockResolvedValueOnce({ status: { state: "ok" } });
    document.querySelector(".artifact-card-action").click();
    await vi.waitFor(() => expect(native.open).toHaveBeenLastCalledWith(expect.objectContaining({ approveServer: true })));
    await vi.waitFor(() => expect(document.querySelector(".artifact-card").hidden).toBe(true));
    // The approved open keeps its chat target, so Annotate stays available.
    expect(document.querySelector('[aria-label="Annotate"]')).not.toBe(null);
  });

  it("shows the start log live, and a failure with Retry and Add to chat", async () => {
    const native = fakeNative({ state: "server-failed", log: "Error: Cannot find module 'vite'" });
    const onAddToChat = vi.fn();
    const viewer = createArtifactViewer({ root: document.body, native, onAddToChat });
    let finish;
    native.open.mockImplementationOnce(() => new Promise((done) => { finish = done; }));
    const opening = viewer.open({ threadId: 1, node: node(app, "Order desk") });
    native.emit({ type: "server-starting", command: "npm run dev" });
    native.emit({ type: "server-log", text: "> vite\n" });
    expect(text(".artifact-card h2")).toBe("Starting the app");
    expect(text(".artifact-card-log")).toBe("> vite\n");
    finish({ status: { state: "server-failed", log: "Error: Cannot find module 'vite'" } });
    await opening;
    expect(text(".artifact-card h2")).toBe("The app did not start");
    expect([...document.querySelectorAll(".artifact-card-actions button")].map((button) => button.textContent)).toEqual(["Retry", "Add to chat"]);
    document.querySelectorAll(".artifact-card-actions button")[1].click();
    expect(onAddToChat).toHaveBeenCalledWith(expect.stringContaining("Cannot find module 'vite'"));
  });
});

describe("Annotate (ART-011)", () => {
  const video = { kind: "video", source: { file: "media/promo.mp4" }, fingerprint: "sha256:a" };
  const target = { nodeId: 27, sourceInteractionNodeId: 5, sourceLayerId: 9 };

  function fakeNotes() {
    const stored = [];
    return {
      stored,
      list: vi.fn(async () => stored.map((text, index) => ({ id: String(index), text }))),
      add: vi.fn(async ({ text }) => { stored.push(text); }),
      remove: vi.fn(async ({ note }) => { stored.splice(Number(note.id), 1); }),
    };
  }

  it("freezes the view, pauses media and adds notes with where and a screenshot to the chat draft", async () => {
    const native = fakeNative();
    const notes = fakeNotes();
    const onClose = vi.fn();
    const viewer = createArtifactViewer({ root: document.body, native, notes, onClose });
    await viewer.open({ threadId: 3, node: node(video, "Promo video"), target });
    const tools = [...document.querySelectorAll(".artifact-toolbar button")].map((button) => button.getAttribute("aria-label") || button.textContent.trim());
    expect(tools).toEqual(["Graph", "Annotate", "More"]);
    document.querySelector('[aria-label="Annotate"]').click();
    await vi.waitFor(() => expect(document.querySelector(".artifact-note-panel")).toBeTruthy());
    expect(native.beginNote).toHaveBeenCalledOnce();
    expect(document.querySelector(".artifact-freeze").getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(text(".artifact-note-where")).toBe("Where: at 0:12");
    const field = document.querySelector(".artifact-note-field");
    field.value = "The logo flickers here";
    field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(notes.add).toHaveBeenCalledOnce());
    expect(notes.add).toHaveBeenCalledWith(expect.objectContaining({ threadId: 3, target, text: `The logo flickers here\n— at 0:12 · screenshot sha256:${"c".repeat(64)}` }));
    await vi.waitFor(() => expect(text(".artifact-note-list li span")).toBe("The logo flickers here\n— at 0:12"));
    expect(text(".artifact-note-count")).toBe("1 in the chat draft");
    document.querySelector(".artifact-note-remove").click();
    await vi.waitFor(() => expect(document.querySelectorAll(".artifact-note-list li")).toHaveLength(0));

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(native.endNote).toHaveBeenCalledOnce());
    expect(document.querySelector(".artifact-note-panel")).toBe(null);
    expect(viewer.isOpen()).toBe(true);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(viewer.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledWith(3);
  });

  it("keeps the screenshot of a note still being confirmed when the viewer closes", async () => {
    const native = fakeNative();
    const notes = { ...fakeNotes(), add: vi.fn(() => new Promise(() => {})) };
    const viewer = createArtifactViewer({ root: document.body, native, notes });
    await viewer.open({ threadId: 3, node: node(video, "Promo video"), target });
    document.querySelector('[aria-label="Annotate"]').click();
    await vi.waitFor(() => expect(document.querySelector(".artifact-note-field")).toBeTruthy());
    const field = document.querySelector(".artifact-note-field");
    field.value = "Too fast";
    field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(notes.add).toHaveBeenCalledOnce());
    viewer.close();
    expect(native.endNote).toHaveBeenCalledWith({ kept: true });
  });

  it("formats a note for the agent and shows it without the screenshot reference", () => {
    const note = artifactNoteText({ text: "  Too dark ", location: "under “Colour”", digest: "d".repeat(64) });
    expect(note).toBe(`Too dark\n— under “Colour” · screenshot sha256:${"d".repeat(64)}`);
    expect(artifactNoteLabel(note)).toBe("Too dark\n— under “Colour”");
  });
});

describe("shares and Eval (ART-008)", () => {
  // The site plays in a sandboxed frame inside a document that frames only its origin.
  const played = () => {
    const held = new window.DOMParser().parseFromString(document.querySelector("iframe.artifact-frame").getAttribute("srcdoc"), "text/html");
    const frame = held.querySelector("iframe");
    return { src: frame.getAttribute("src"), sandbox: frame.getAttribute("sandbox"), policy: held.querySelector("meta").getAttribute("content") };
  };

  it("play an https artifact in a sandboxed frame and show a card, with no path, for a local one", async () => {
    const viewer = createArtifactViewer({ root: document.body });
    await viewer.open({ threadId: 1, node: node({ kind: "url", source: { url: "https://example.com/" } }, "Deployed site") });
    expect(played()).toEqual({ src: "https://example.com/", sandbox: "allow-scripts allow-same-origin allow-forms", policy: "frame-src https://example.com" });
    // Review #9 and #20: routes resolve against the base, and the scheme is case-insensitive.
    await viewer.open({ threadId: 1, node: node({ kind: "url", source: { url: "HTTPS://example.com/app/" }, part: { route: "/pricing" } }, "Deployed site") });
    expect(played().src).toBe("https://example.com/pricing");
    await viewer.open({ threadId: 1, node: node(site) });
    expect(document.querySelector("iframe")).toBe(null);
    expect(text(".artifact-card-note")).toBe("Available in Relayer on the machine that made it.");
    expect(document.body.textContent).not.toContain("site/index.html");
    expect(text(".artifact-strip-text")).toBe("Landing page");
    await viewer.open({ threadId: 1, node: node({ kind: "url", source: { url: "http://localhost:5173/" } }, "Dev server") });
    expect(document.querySelector("iframe")).toBe(null);
    expect(text(".artifact-card-note")).toBe("Open this site in your browser to view it.");
    expect(document.querySelector(".artifact-toolbar [aria-label='More']")).toBe(null);
  });
});
