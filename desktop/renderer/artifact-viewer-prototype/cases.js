// PROTOTYPE — throwaway (issue #684). The case matrix: every promise and boundary
// from the spec, each with a way to open it in the prototype. The capture runner
// (scripts/fixtures/artifact-viewer-prototype/capture-cases.mjs) drives each case
// and records what it observed.
export const GROUPS = [
  ["types", "1 · Content types", "Every kind the spec lists opens live in the full-screen viewer."],
  ["parts", "2 · Parts, state and screen", "The node says which part to show, the starting state and the screen size."],
  ["chrome", "3 · Viewer chrome", "Full-screen with an auto-hiding toolbar; the address is always visible."],
  ["integrity", "4 · Integrity at submission", "Deterministic rules the agent gets back as repairable errors."],
  ["after", "5 · After acceptance", "What the viewer shows when things change after the answer was accepted."],
  ["server", "6 · Server invoke (apps)", "Use the running server, otherwise start it. No model, no graph record."],
  ["annotate", "7 · Annotations and sending", "Notes become chips in the chat draft; Enter sends one interaction."],
  ["surfaces", "8 · Share and Eval", "Other surfaces show local artifacts as a card; https URLs play live."],
  ["q3", "9 · Q3 — what clicking Annotate looks like", "Six options. a–c are the first round; d–f are the lower-profile round. Chat input placement is C."],
  ["o1", "10 · O1 — where the chat input lives (decided: C)", "Four placements of the chat input inside the full-screen viewer. You picked C on 2026-10-06."],
];

const open = (layer, extra = "") => `/artifact-viewer.prototype.html?open=layer:${layer}${extra}`;

export const CASES = [
  // 1 · Content types
  { id: "T1", group: "types", title: "Static website", refs: "D2 D6 D35", expect: "The site in site/ runs live; the address strip shows tidewater-launch/site/.", link: open("art-site") },
  { id: "T2", group: "types", title: "Web app (server invoke)", refs: "D2 D37", expect: "First open asks to run the command; after Allow the app loads with a 'Started by Relayer' badge.", link: open("art-app") },
  { id: "T3", group: "types", title: "Deployed https site", refs: "D17 D24", expect: "https://example.com/ loads live with a lock in the address.", link: open("art-url") },
  { id: "T4", group: "types", title: "PDF", refs: "D2", expect: "pdf.js renders the brief; location reads 'Page 1 of 5'.", link: open("art-pdf") },
  { id: "T5", group: "types", title: "Video", refs: "D2", expect: "The WebM promo plays with native controls.", link: open("art-video") },
  { id: "T6", group: "types", title: "Image (PNG)", refs: "D2", expect: "The hero image fits the screen; click toggles actual size.", link: open("art-hero") },
  { id: "T7", group: "types", title: "Image (SVG)", refs: "D2", expect: "The logo renders from the site folder.", link: open("art-logo") },
  { id: "T8", group: "types", title: "Markdown", refs: "D2", expect: "The brand guide renders as a document.", link: open("art-guide") },
  { id: "T9", group: "types", title: "Word (.docx)", refs: "D10", expect: "docx-preview renders headings, bullets and the pricing table.", link: open("art-docx") },
  { id: "T10", group: "types", title: "Excel (.xlsx)", refs: "D10", expect: "SheetJS renders the Budget sheet. The bar chart in the workbook is not shown (known fidelity loss).", link: open("art-xlsx") },
  { id: "T11", group: "types", title: "PowerPoint (.pptx)", refs: "D10 D10b", expect: "pptx-preview renders the 4-slide deck. The column-chart slide is the fidelity test (D10b: accept weak PowerPoint for now).", link: open("art-pptx") },

  // 2 · Parts, state and screen
  { id: "P1", group: "parts", title: "PDF page", refs: "D11", expect: "Opens straight on page 4 (Use of funds).", link: open("art-pdf-p4") },
  { id: "P2", group: "parts", title: "Video segment", refs: "D11", expect: "Starts at 0:10 and stops at 0:15; 'Play the whole video' lifts the limit.", link: open("art-video-ship") },
  { id: "P3", group: "parts", title: "Markdown section", refs: "D11", expect: "Opens at the Colour section.", link: open("art-guide-colour") },
  { id: "P4", group: "parts", title: "Route on a phone screen", refs: "D11 D32", expect: "Pricing section in a 390×844 frame.", link: open("art-site-phone") },
  { id: "P5", group: "parts", title: "Seeded state (localStorage + cookie)", refs: "D16 D23", expect: "Cart shows 2 items and 'Welcome back, Maya' from the seed.", link: open("art-site-cart") },
  { id: "P6", group: "parts", title: "State resets on every open", refs: "D23", expect: "Emptying the cart inside the artifact, then reopening, shows the seeded 2 items again.", link: open("art-site-cart") },
  { id: "P7", group: "parts", title: "Isolation per artifact", refs: "D6 D23 (ART-003/004)", expect: "Artifact code cannot read Relayer's API; one artifact cannot see another's storage.", link: open("art-site") },

  // 3 · Viewer chrome
  { id: "V1", group: "chrome", title: "Toolbar auto-hides, address stays", refs: "D13 D21", expect: "After ~3 s the toolbar slides away; the slim address strip remains. Hovering the strip brings it back.", link: open("art-site") },
  { id: "V2", group: "chrome", title: "No actions or references in the viewer", refs: "D8 D21 · decided 2026-10-06", expect: "The top bar has only Graph (back), the title, the address, Annotate and ⋯. The artifact node's links are not shown in the viewer.", link: open("art-site") },
  { id: "V3", group: "chrome", title: "Related views stay in the graph", refs: "D8 D33", expect: "Esc leaves the viewer; the Landing page node's Node Details still offer Open the site, Pricing on a phone and Cart as a member.", link: "/artifact-viewer.prototype.html" },
  { id: "V4", group: "chrome", title: "Back / Esc", refs: "D13", expect: "Esc (or Graph in the top bar) returns straight to the graph, where you were.", link: open("art-site") },
  { id: "V5", group: "chrome", title: "Link to another site", refs: "D21 (baseline)", expect: "Clicking Instagram in the site does not navigate the artifact; it opens in the user's browser.", link: open("art-site") },
  { id: "V6", group: "chrome", title: "No description shown", refs: "D39", expect: "The viewer shows only the artifact: no Node Details text.", link: open("art-site") },

  // 4 · Integrity (filled from /proto/config rejections at runtime)
  { id: "I0", group: "integrity", title: "Every fixture artifact passes", refs: "D22 D31", expect: "All 21 accepted artifact nodes pass the submission rules.", link: "/proto/config" },

  // 5 · After acceptance
  { id: "A1", group: "after", title: "Changed since accepted", refs: "D14 D36", expect: "The brand guide's fingerprint differs: badge 'Changed since this was accepted'.", link: open("art-drift") },
  { id: "A2", group: "after", title: "Edited live, then reopened", refs: "D14 D36", expect: "Editing site/styles.css (matrix button) makes the landing page show the badge; editing again restores it.", link: open("art-site") },
  { id: "A3", group: "after", title: "File deleted after acceptance", refs: "D22", expect: "Card: 'This file is no longer in the thread folder', with Add to chat. No agent turn starts.", link: open("art-missing") },
  { id: "A4", group: "after", title: "Page script error", refs: "D22", expect: "Badge '1 page error'; the error text can be added to the chat.", link: open("art-js-error") },
  { id: "A5", group: "after", title: "No fingerprint for URLs", refs: "D36", expect: "The deployed site shows no 'changed' badge.", link: open("art-url") },

  // 6 · Server invoke
  { id: "S1", group: "server", title: "Approval the first time", refs: "D37", expect: "Card names the command and folder; nothing runs before Allow.", link: open("art-app") },
  { id: "S2", group: "server", title: "Start, wait for ready, show log", refs: "D37", expect: "After Allow: 'Starting the app…' with the log, then the app.", link: open("art-app") },
  { id: "S3", group: "server", title: "Reopen reuses it", refs: "D37", expect: "Second open loads at once with no approval card.", link: open("art-app") },
  { id: "S4", group: "server", title: "Agent left it running", refs: "D37", expect: "Kitchen display loads at once: 'Using the server the agent left running'. Relayer never stops it.", link: open("art-kitchen") },
  { id: "S5", group: "server", title: "Start fails", refs: "D37", expect: "'The app failed to start' with the last log lines, Retry and Add log to chat.", link: open("art-broken-app") },
  { id: "S6", group: "server", title: "Idle stop", refs: "D37", expect: "A server Relayer started stops after the idle timeout once nobody views it (prototype: 60 s; spec: about 1 hour).", link: "/artifact-viewer-matrix.prototype.html#processes" },
  { id: "S7", group: "server", title: "No graph record", refs: "D37", expect: "Starting the app adds no turn and no node: the thread stays at Turn 1.", link: open("art-app") },

  // 7 · Annotations
  { id: "N1", group: "annotate", title: "Annotate a website view", refs: "D25", expect: "Popover shows the route, a screenshot of what you see, and a note field; Enter adds a chip.", link: open("art-site-cart") },
  { id: "N2", group: "annotate", title: "Location for PDF and video", refs: "D25", expect: "Annotations record 'Page 4 of 5' or the video timestamp.", link: open("art-pdf-p4") },
  { id: "N3", group: "annotate", title: "Several notes, one interaction", refs: "D26 D8 D40", expect: "Two chips + a message → Enter → Turn 2 with the artifact attached as context and one response.", link: open("art-site", "&variant=A") },
  { id: "N4", group: "annotate", title: "One shared draft", refs: "D27", expect: "Chips added in the viewer sit above the thread composer after Esc.", link: open("art-site", "&variant=C") },
  { id: "N5", group: "annotate", title: "Send is never disabled", refs: "D27", expect: "The Send button is always enabled; an empty send does nothing.", link: open("art-site", "&variant=A") },

  // 8 · Surfaces
  { id: "X1", group: "surfaces", title: "Share: local artifact", refs: "D20", expect: "Card: 'Available in Relayer on the machine that made it'. No Annotate, no Open externally, and no local folder name or path anywhere.", link: open("art-site", "&surface=share") },
  { id: "X2", group: "surfaces", title: "Share: https URL", refs: "D20", expect: "The deployed site plays live.", link: open("art-url", "&surface=share") },
  { id: "X3", group: "surfaces", title: "Eval: local artifact", refs: "D29", expect: "Same card as Share.", link: open("art-pdf", "&surface=eval") },

  // 9 · Q3 Annotate options
  { id: "Q3-a", group: "q3", title: "a · Panel drops from the icon", refs: "Q3 Q4 Q5", expect: "A small panel hangs from the Annotate icon: earlier notes with ×, then a thumbnail, the location and a one-line note. The video pauses while it is open.", link: open("art-video", "&variant=C&annotate=a") },
  { id: "Q3-b", group: "q3", title: "b · Popover at the bottom", refs: "Q3 Q4 Q5", expect: "A larger popover at the bottom with earlier notes, a big screenshot and a note box. The video pauses while it is open.", link: open("art-video", "&variant=C&annotate=b") },
  { id: "Q3-d", group: "q3", title: "d · Note field inside the toolbar", refs: "Q3 Q4 Q5", expect: "The toolbar's middle turns into a one-line note field with the location; nothing opens over the artifact. The screenshot is taken silently (camera mark). '1 note' opens earlier notes.", link: open("art-video", "&variant=C&annotate=d") },
  { id: "Q3-e", group: "q3", title: "e · Thin note bar at the bottom", refs: "Q3 Q4 Q5", expect: "A 46 px bar along the bottom edge; the artifact shrinks to make room so nothing is covered. Silent screenshot, '1 note' chip for earlier notes.", link: open("art-video", "&variant=C&annotate=e") },
  { id: "Q3-f", group: "q3", title: "f · Click to drop a pin", refs: "Q3 Q4 D25", expect: "Click a spot: a numbered pin drops with a tooltip-sized field beside it. Earlier pins on this artifact show while pinning; hover to read or remove.", link: open("art-site", "&variant=C&annotate=f") },
  { id: "Q3-c", group: "q3", title: "c · Mark an area first", refs: "Q3 Q4 D25", expect: "The artifact dims; you drag a box around the spot, then the note panel sits beside it with a cropped, outlined screenshot.", link: open("art-site", "&variant=C&annotate=c") },

  // 10 · O1 variants
  { id: "O1-A", group: "o1", title: "A · Docked chat input", refs: "O1", expect: "A thread-style input is always docked at the bottom; chips sit above it.", link: open("art-site", "&variant=A") },
  { id: "O1-B", group: "o1", title: "B · Floating chat bubble", refs: "O1", expect: "A bubble in the corner expands into a small chat panel; the artifact keeps the full screen.", link: open("art-site", "&variant=B") },
  { id: "O1-C", group: "o1", title: "C · Leave full-screen to send", refs: "O1", expect: "No input in the viewer: notes collect, a hint says press Esc and send from the thread composer.", link: open("art-site", "&variant=C") },
  { id: "O1-D", group: "o1", title: "D · Review drawer", refs: "O1", expect: "A right drawer lists notes as cards with screenshots, with an overall message at the bottom.", link: open("art-site", "&variant=D") },
];
