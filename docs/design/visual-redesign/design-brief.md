# 12 — Final design brief: Relayer colour, object types, light/dark and sizing

**Four prototypes for a branch-width-4 search (generation 1). Final version.**

This is the lead designer's final brief for the four prototype builders. It is `10-design-brief.md` with every valid point
from the adversarial review `11-brief-critique.md` applied, plus corrections from my own re-checks against the repo and a
re-run of the colour search. Appendix C records how each critique point was handled; rejected points have a one-line
reason. Repo snapshot: `origin/main` @ `76bfe5fe`, worktree
`<repo>`. The share viewer
lives on `origin/codex/share-gate-b-462-467`. No repo file was edited, nothing was built or tested, and no paid inference
was used.

**How to use this brief.**

- A builder needs only this file and
  `<scratchpad>/research/palettes.json`.
- Sections 2 and 3 are identical for all four prototypes. They are what make the prototypes comparable, so follow them
  exactly. Section 6 is where the prototypes must differ; it gives each builder a full specification. Section 7 is the
  rubric Vishal will comment against.
- **Token precedence.** Every value printed in this brief wins over `palettes.json`. Values marked **†** differ from
  `palettes.json`. For any token this brief does not print, use the `palettes.json` value for that palette and theme.
- **Two renamed tokens.** `palettes.json` `raised` is called `--field` here (it is the input/composer/chip surface, and in
  light mode it is *darker* than the page, so "raised" was misleading). `palettes.json` `focus-ring` is called
  `--selection-ring` here, because keyboard focus is now always `--text` (§2.5).
- **Family colours.** Use only the family tables in §6. The `categorical` block in `palettes.json` is superseded (A is
  fully replaced; B, C and D have one or two slots replaced).
- Where this brief contradicts a research report (01–08), this brief wins. §8.2 lists every such correction.

**Plain-English glossary** (terms used below):

- **Token**: a named design variable, such as `--text`. Every screen uses the name, so one change reaches everywhere.
- **Contrast ratio**: how much lighter one colour is than another, from 1:1 (identical) to 21:1 (black on white).
  The accessibility rules (WCAG 2.2 AA) require:
  - **4.5:1** for normal text;
  - **3:1** for large text;
  - **3:1** for meaningful lines and shapes, such as graph edges, node outlines and focus rings ("non-text contrast").
- **APCA Lc**: a newer, advisory contrast score that handles dark mode better. It is reported as "Lc 60" and similar.
- **OKLCH**: a colour notation (Lightness, Chroma = colourfulness, Hue angle) in which equal number steps look like equal
  visual steps.
- **ΔE**: how different two colours look (OKLab distance × 100). About 2 is barely noticeable, 10 is clearly different,
  15 or more is very different. "CVD ΔE" is the same distance after simulating red-green colour blindness.
- **CVD**: colour-vision deficiency ("colour blindness").
- **Chrome**: the app furniture around the content, such as the sidebar, bars and buttons.
- **Canvas**: the graph area.
- **Inspector**: the right-hand panel that shows Node Details.
- **Hit target**: the clickable area of a control.
- **Type scale**: the fixed set of text sizes the product uses.
- **Fit**: the camera command that zooms so the whole layer fits the canvas.
- **Semantic zoom / tier**: zooming changes *what* is drawn, not only its size. Overview (< 0.6×) draws small tokens with
  no labels; card (0.6–1.4×) draws the normal node; detail (> 1.4×) adds a caption and an excerpt.
- **Halo**: a thin outline around text, drawn in the background colour, so lines behind the text don't cut through it.
- **Hollow**: a node body painted in the canvas colour. It is one of the ways "draft" is shown.
- **Default (solid)**: the ordinary look of any node that is not draft. It carries **no acceptance meaning** (§2.1).
- **Semantic child completion**: a separate completion that agent-authored code starts by calling Complete from a node's
  action. It is different from a provider's *native helper*, which never becomes a child (`CONTEXT.md`).
- **Leading bar**: a 3px vertical bar at the left edge of a selected row or tab.
- **Peek**: the lowest resting position of a phone bottom sheet, showing only its top part.
- **Artboard**: one fixed-size frame on the design canvas.
- **Redundant encoding**: showing one meaning in two independent ways, such as colour plus a glyph.
- **Test pin**: a repo test that asserts an exact CSS string or DOM fact, so changing it means changing the test on purpose
  (AGENTS.md step 4).
- **OFL**: SIL Open Font License, which permits bundling and redistributing a font.
- **CSP**: Content Security Policy, the browser rule that says where a page may load files from.
- **[PD]**: "needs a product decision". It may be drawn, but must be labelled as a proposal (§8.1).

---

## 1. Diagnosis of the current UI (ranked by user impact)

Ranked by how many users hit the problem, how often, and how badly it blocks understanding. Evidence comes from reports
01–04 and my re-checks. Line numbers refer to the minified `desktop/renderer/styles.css` (physical lines).

| # | Problem | Evidence (file:line, measured value) |
|---|---|---|
| **1** | **The graph has no visual vocabulary.** Every node is identical: a 46px `#191c20` circle, a 1px `#515860` ring, a white Lucide icon and an 11px bold label. Node `kind`, record `state` (draft/accepted/stopped), capabilities (opens a layer, invoke, input, attached as context) and relations are never drawn. Colour is 100% absent except a 6px status dot. | `styles.css:L8`; `kind` shown only as an 8px faint caption, `workspace.js:4900`; the renderer never reads `.state` (grep of `desktop/renderer/src/product-workspace/*.js`); edges are one class, `workspace.js:4461-4478` |
| **2** | **Explicit states are not honoured.** Accepted is *hidden*. Waiting, Running and Stopping share one static blue dot, and the `pulse` keyframe is defined but unused. A retained "current" layer after Stop looks identical to a final accepted answer. This contradicts AGENTS.md ("Preserve explicit draft, accepted, and stopped states") and PRD §5 ("Running, stopping, stopped, failed, and accepted are explicit states"). | `workspace.js:409-423`, `:417-418`; `docs/prd/index.html:289`, `:2165`; `docs/architecture.md:153`; `docs/evidence/issue-506-stop/codex-02-stopping.png` vs `codex-03-stopped.png` |
| **3** | **Node size is coupled to zoom, which inverts hierarchy.** Fit (padding 48px, `workspace.js:157`) zooms small layers up to 200%, so 1–3-node layers open with **92px circles and 22px bold labels** beside 13px chrome. At 40% the label is **4.4px**. Edges run through labels. | `workspace.js:77-78` (`GRAPH_NODE_ICON_RADIUS = 24`, `GRAPH_MAX_ZOOM = 2`), `:314-326`; `styles.css:L60`; `issue-506-stop/prime-01-running.png`; `07-sources/label-edge-crop.png` |
| **4** | **Meaningful graphics and faint text fail contrast in both themes.** Edges are 2.37:1 dark and **1.43:1 light**. Node rings are 2.72:1 dark and 1.43:1 light. The selection ring is **1.18:1**. `--faint` text is 3.69:1 dark and **2.42:1 light**, and it is used 55 times, mostly on 9–10px labels. In light mode, the dot grid, edges and node rings are all the same `#d6d3d1`. | Appendix C of 01; `styles.css:L36-38` |
| **5** | **Light mode is a partial re-skin with the wrong accent.** The token named `--blue` becomes **amber `#b45309`** in light, while 46 dark-only literal rules have no light override. Examples: env `+adds` `#46d889` at 1.84:1 on white; approval dot `#e3bd62` at 1.79:1; dark chips inside white cards. Light mode shows two accents at once (amber borders plus blue rings). Dark neutrals are cool (hue ≈250°) and light neutrals are warm (stone, hue ≈50–75°), so switching theme changes the brand temperature. There is no System option. No light screenshot of a thread canvas exists anywhere. | `styles.css:L1`, `:L26`; 01 §2.1; `ui.js:6-11`; `register-ipc.mjs:103`; `index.html:6` |
| **6** | **Micro-type.** 108 of 170 sized rules (64%) are 10px or smaller. 7px, 8px and 9px are used 54 times, below Apple's 10pt macOS minimum. There are 15 sizes and 67 type combinations, plus off-grid weights (650/680/750/760). Inter is declared but **not bundled**, so users actually see SF Pro or Segoe UI. | 01 §3, Appendix B; no `@font-face` in `desktop/` |
| **7** | **Chrome eats the canvas.** At 1280×848 the graph gets 673×610px (53% of width). 176px of stacked bars sit above the canvas. The 340px right rail shows "No project folder" in about 110px and then about 600px of emptiness. The thread title appears three times. | 01 §5.1, P6; `issue-506-stop/*` |
| **8** | **Selection, hover and focus are indistinguishable.** Hover equals selected for sidebar rows, settings tabs and graph nodes. `.graph-node` (role=button) has no `:focus-visible` style, and 11 rules use `outline:0`. | `styles.css:L4`, `:L8`; 04 §1.12 |
| **9** | **Share viewer: it inherits everything above, plus its own defects.** | See the list below this table. |
| **10** | **Hit targets below 28px.** Comment Edit/Retract links are ≈10px tall; rating words ≈11px; the annotation badge is 19×19; the breadcrumb is 26px; history arrows are 27px; zoom buttons are 29px. | 01 §7 P8 |
| **11** | **No system discipline.** There are 163 colour literals outside tokens (≈37% of colour values), 17 radii, ≈41 shadows and 35 padding values. There are four palettes across desktop and eval. Chrome uses Unicode glyphs (`›_ ◌ ◇ ⌁ ⌘ ✦ ◎ ◉ ◐`), and `⌘` means two different things. | 01 §2, §7 P9; 02 §4 |
| **12** | **Thin identity.** The brand is a 24px cream tile. There is no brand accent in the primary action. The website uses indigo `#6366f1`, which the product has never used. The logo's cream `#FAF2E6`, black ink and red-orange deck `#D74326` already follow the reel's "ground + ink + one accent" formula, but the UI ignores them. | 04 §4; `desktop/renderer/assets/relayer-logo.svg` (a 192×192 PNG inside an SVG) |

Share viewer defects referenced in problem 9:

- The only branding is a 28px logo plus 12px "Relayer for Mac".
- Nothing tells a stranger that this is a **frozen read-only snapshot**. There is no date, and the project name is invisible on the page.
- The theme is set **by JavaScript only**, so light-mode visitors see the dark theme flash in while the page streams, and see dark with JavaScript off.
- The left gutter is 0px.
- A 340px column sits empty until a node is selected.
- On a phone:
  - `touch-action:none` creates a **scroll trap**;
  - the hint pill and zoom control collide at 375px;
  - `100vh` is wrong on iOS Safari;
  - text is 8–10px.
- The OG image is an SVG that social crawlers don't render, and its `og:image` URL is relative.
- Sources: 03 §1–§5; `viewer.css:106-113`, `:195-226`; `main.js:16-24`; `styles.css:8` (`touch-action`).

**What the diagnosis implies.** Fix the graph first: object types, states, and size decoupled from zoom. Then fix
contrast and light-mode parity. Then fix type size and space allocation. Colour is the smallest part of this job. The
larger part is giving every meaning its own visual channel.

---

## 2. Invariants every prototype must keep

A prototype that breaks one of these is out of the search, however good it looks. Items marked **[PD]** are proposals
that need a product decision before they ship (§8.1). Prototypes may draw them, labelled as such on the system sheet.

### 2.1 Product states (must stay explicit and distinct)

- **Turn / interaction states**: Waiting, Running, Needs approval, Stopping…, Stopped, Failed, Cancelled and **Accepted**.
  Accepted must now be **visible**; today it is hidden (`workspace.js:417-418`). Each state has a **glyph + a text label**,
  never colour alone (WCAG 1.4.1).
- **Record states**: `draft | accepted | stopped` (`crates/relayer-graph-core/src/graph/model/record_state.rs:7-11`).
  - Record-level `stopped` exists only on **discarded orphan layers** (`crates/relayer-graph-core/src/graph/writer.rs:352,382`).
    Those layers are never shown, so record-stopped is **never rendered**.
- **Acceptance is drawn only at turn and layer level.** Nodes inside a working (current) layer have the record state
  `accepted` in the data, because advancing the current layer accepts its records (02 §2.2). They are still drawn in the
  **Default (solid)** look, which carries no acceptance meaning. **No ✓ glyph and no success colour may appear on the
  canvas while the canvas frame says "Working".** The word "Accepted" and the ✓ glyph belong to the turn pill, the turn rows
  and a returned (final) layer.
- **Product rules that constrain every state treatment**:
  - *A model turn ending is not acceptance* (PRD `:2124-2125`).
  - *Stop and failure never create an accepted response layer*; *draft work from a stopped interaction must not appear as
    accepted output* (PRD §5; `:2177`).
  - A working (current) layer must look different from a final accepted one **[PD for drawing working layers on canvas]**.
- **Status colours are reserved.** A node's family colour may never impersonate a status, the selection ring or the running
  mark. The exact rules are in §3.3.
- **Running must be readable in a still frame.** A running node always carries the running badge (§3.2) and, at card tier,
  a "Running" caption. Motion is an extra cue, never the only one.

### 2.2 Controls that are specified or test-pinned

- **Stop**:
  - While running, the composer's send control becomes a **10px square** Stop glyph. While **Stopping**, a spinning ring
    (`stop-button-spin`) surrounds the square, the control is disabled, and it carries `aria-busy`. The Send glyph (the
    text "↑") returns once the turn has stopped (`scripts/test-desktop-stop.mjs:51-62`).
  - **Stop and the stopped notice use neutral theme colours, never red or danger** (PRD `:2175`, STOP-006 `:2199`). The
    test asserts that the Stop background equals the `#composerRetryMessage` background, and that the stopped notice colour
    equals the status pill (`#interactionStatus`) colour.
  - The Stop control is vertically centred beside the input (within 1px).
  - Under reduced motion the ring does not spin.
- **Composer**:
  - The Model button sits **immediately before** Submit/Stop (PRD `:795`).
  - Send is disabled when the composer is empty.
  - The context pill uses a solid border and shows a count. The input pill uses a **dashed** border.
- **Permission profile** labels are exact: "Ask for approval", "Approve for me", "Full access" (PRD `:1105-1111`). Full access
  carries its disclosure ("filesystem and network access are not hard-confined"). They are drawn on the X6 New-thread
  specimen (§4.6).
- **Header** (PRD `:1230`: "The header shows the current thread title, scope, and backward/forward turn controls"; pinned by
  `test/workspace-navigation-controls.test.mjs:101-126`):
  - Before `</header>`: Back (`#historyBack`), Forward (`#historyForward`), the thread title group (`#threadTitle` plus the
    scope line), and the **••• Conversation settings** button (`#conversationSettingsButton`, whose menu holds "Export
    conversation…", plus "Share…" on the share branch).
  - There is no `#runState` in the header.
  - Turn controls (the pager and the turn picker) stay **inside `#interactionBanner`** (the prompt card), after
    `#interactionText`.
  - **No eyebrow.** The prompt card must not contain "Your interaction" or `#interactionModelIdentity` (the test asserts both
    are absent, `:124-125`). Showing the model identity in the prompt card would be **[PD]**.
  - **Merges are visual only.** A prototype may restyle the header and prompt card, but the DOM order header →
    `#interactionBanner` → breadcrumb → canvas stays unchanged.
  - Back/Forward show destination hover labels and disable at the ends of history (PRD `:2311`).
  - The turn pager reads "**Turn N of M**", and plain Left/Right arrow keys move one turn (PRD `:2312`).
  - Clicking the count opens a chronological popover with **52px rows** and **three complete rows visible**
    (`test/workspace-navigation-controls.test.mjs:203-210`).
- **Breadcrumb**:
  - Row height **40px** (pinned: `.workspace-breadcrumb{min-height:40px`, `test/workspace-breadcrumb.test.mjs:193`).
  - It starts at the **same x as the prompt text** above it (PRD `:2304`: "The interaction query and breadcrumb share the
    same left edge above the canvas").
  - It contains only the accepted parent-child path (PRD `:2305`).
  - The root is "Response" with the `messages-square` icon, and the breadcrumb is **hidden when only the root shows**
    (`workspace.js:541-550`). In the canonical scene (root layer), it is therefore hidden.
- **Canvas controls**: − / zoom % / + / Fit / recenter, plus a drag/zoom hint.
- **Inspector (Node Details)**:
  - It sits on the right.
  - Authored actions come first, and the universal **+** (attach context) is **last** in the row.
  - The annotation dock is about **one third** of the inspector height (`.node-context-dock{height:33.333%`,
    `test/workspace-keyboard.test.mjs:595`), and Node Details scroll independently above it (PRD `:2211`).
  - Authored Node Details must render at content widths from **260px to 420px** (PRD `:2383`) on a **plain, high-contrast
    surface**.
  - The shadow root inherits `color` and `font`, so keep the inherited text colour ≥ 4.5:1 on the inspector surface.
- **Sidebar**:
  - It contains New thread (with the ⌘N kbd), CHATS and PROJECTS (PRD `:1228`). Project threads are nested under their
    project row (`navigation.js:92-100`).
  - The footer holds Settings, Account and the **highlighted circular update icon**, with no version text.
  - **No draft badge, dot or label** (SCP-017, PRD `:1133`).
  - Running / Needs approval / Failed marks on thread rows are **[PD]**: today only the active row is shown
    (`navigation.js:63`), and the PRD calls the sidebar "a compact list" (`:1229`).
  - The project-row compose button appears on hover or focus **without layout shift**.
  - The collapsed shell keeps Relayer, New Thread and Settings as icons, with the collapse toggle beside the macOS
    traffic lights.
  - The window uses `hiddenInset`, so keep a 44px top reserve and the toggle near `left:84px`.

### 2.3 Layout regions

- **Desktop regions**:
  - sidebar | main (header → prompt card → breadcrumb → canvas → composer) | inspector.
  - Allowed variations: the header and prompt card may be restyled (DOM order fixed); the inspector may float **[PD]** or
    collapse when empty **[PD]**; the composer may float. A floating or collapsing inspector covers or reflows the graph,
    which is why it needs a decision.
  - Settings is a **full main view**, not a window (PRD `:1345`). There is **no run dashboard, activity feed, trace view,
    comparison workspace, avatar, preference badge or token streaming** (PRD `:1230`, `:3075-3077`, PPG-006, AGT-001).
- **Window**: default 1420×900, **minimum 960×640**. Artboards are 1440×900.
  - At ≤1100px the inspector stacks below the graph today. Making it a right overlay sheet instead is **[PD]** (PRD `:585`
    names small-window layout as a desktop requirement).
- **Share viewer regions**:
  - It has **no** sidebar, settings, onboarding, updater, sign-in, composer, approval dock, annotation panel, telemetry,
    cookies or report link.
  - The **existing `.thread-header` row, carrying the share title and the meta line, is the "thin public bar"** that main's
    PRD asks for (`:1247`). This satisfies main's wording and the branch tests, which forbid only a `public-share-topbar`
    and a `public-share-footer` (`test/public-share-viewer.test.mjs:309-317`, branch). Do not add any other bar.
  - The **download card is the only branding** ("Relayer for Mac", pitch "Explore this thread, then build your own.",
    Download), in the product primary button style. The pitch string exists on the share branch only.
- **Implementation constraint**: restyle existing DOM structures and IDs; don't rename them. There are 212 IDs, and many
  are test-pinned, for example `#sendInteraction`, `#interactionStatus` and `#composerRetryMessage`. Each prototype lists
  the pins it would break (§6.x "Test pins"). These pins break in **all four** prototypes:
  - `test/graph-camera.test.mjs:86-90` (edge thickness scales with zoom), `:112-121` (edge endpoints clip at `24 × zoom`)
    and `:139-148` (wrapped-title layout bounds `{halfWidth: 82, top: 28, bottom: 237}`): screen-constant nodes and
    non-scaling edges change all three.
  - `test/tutorial-visual-contract.test.mjs:23-49`: the onboarding coach-mark pins `--tutorial-surface:#17243a`,
    `#edf4ff`, the `#80aef8` target outline and its contrast thresholds. Any palette restyle of the coach-mark breaks it.
  - `test/public-share-viewer.test.mjs:321` (branch): `.public-share-main{height: 100vh}` must become `100dvh`.

### 2.4 Graph grammar

- **Edges are visually undirected**: no arrowheads and no direction cues (PRD `:2302`). The data model has no edge kind or
  direction.
- **Nodes are movable icon + title objects** (PRD `:2307`). Icons come from the **116-name Lucide allowlist**
  (`icons.js:9-126`, Lucide 0.562.0). Unknown names fall back to a neutral `circle`.
- **1–8 nodes per layer.** Six to eight need a hidden justification. Fit, pan, zoom and the inspector change **only the
  camera**. Dragging a node is an ephemeral local override.
- **Relations stay nameless.**
  - The product does **not expose navigate relations**, meaning expand vs reference (PRD `:1829`, `:2255`). So there is
    exactly **one generic "opens a layer" mark**.
  - There is no universal "Go deeper" button (`:2258`).
- **Hidden objects stay hidden**: the personal-presentation profile and the invoke lease adjacency (ADR 0009, ADR 0005).
- **Children**: node-level running, stopped and failed marks describe a **semantic child completion** started from that
  node's action. A provider's native helper is never drawn as a child (`CONTEXT.md`).

### 2.5 Accessibility floor (proposed as the explicit bar; the PRD sets no number yet)

- **WCAG 2.2 AA everywhere**:
  - text ≥ 4.5:1 (large text ≥ 3:1);
  - meaningful graphics (edges, node outlines, status solids, focus and selection rings) ≥ 3:1 against every surface they
    sit on.
- **Design margin for thin strokes: ≥ 3.2:1** for any meaningful stroke of 2px or less (edges, node outlines, borders,
  rings, draft and failed outlines). A 1.5px line is anti-aliased and renders below its nominal ratio (08 §7). Every token
  table in §6 already meets this.
- **APCA advisory targets**: primary text Lc ≥ 75, secondary text Lc ≥ 60. Known misses are listed in §8.3.
- **Text size and colour**:
  - No text below 11px.
  - Uppercase micro-labels are 11px/600 with +0.06em letter-spacing in `--text-muted`. Do not use small caps: true small
    caps render near x-height (about 7–8px).
  - **Placeholders use `--text-muted`** (≥ 4.5:1). WCAG 1.4.3 has no exemption for placeholder text in an enabled field
    (https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html); `--text-faint` measures only 3.00–3.31:1 on
    `--field`.
  - `--text-faint` is **only** for disabled controls and decoration.
- **Focus**: every focusable element gets a **2px `--text` ring with a 2px offset** (≥ 11.7:1 on every standard surface;
  on D's olive sidebar the ring is `--sidebar-text`, ≥ 6.69:1). This includes graph nodes, where the focus ring sits
  outside the selection ring. The accent colour is never the focus colour, because
  accent rings fail on selected rows (A-light `#7779DF` on `--selected` 2.88; B-light `#E65979` on `--selected` 2.67).
- **Selection**:
  - On the graph: the accent **selection ring only**. **Selection never changes the fill under a type mark**, because the
    darker or lighter `--selected` fill pushes family colours below 3:1 (A-dark F1 2.91; C-light F1 tab 2.58).
  - On rows and tabs: `--selected` fill **plus a 3px leading bar** (`--accent-text`; D uses `--text` in light and ice
    `#D5E3FB` in its dark sidebar) **plus weight 600**. The bar is needed because `--hover` vs `--selected` is only
    1.07–1.11:1 in all eight themes.
- **Hover**: rows use the `--hover` fill; graph nodes change only their stroke, to `--edge-strong`.
- **Hit targets** ≥ 24×24 on desktop (28 preferred) and ≥ 44×44 on phone.
- **Motion**:
  - Only **Running** and **Stopping** loop. Nothing flashes (WCAG 2.3.1).
  - B's acceptance stamp is static; it may fade in once (≤ 200 ms).
  - Under `prefers-reduced-motion`: nothing loops or fades; running shows its badge only; the Stopping ring is static.
  - Under `forced-colors`, states survive as shape, line style and glyph.
  - `prefers-reduced-transparency` removes blur.
- **Colour never carries meaning alone.** Family = hue + icon. State = line, fill and glyph + label.

### 2.6 Fonts (bundle-able, OFL)

- Every bundled typeface must be **SIL OFL 1.1**, shipped as local `.woff2` files under `desktop/renderer/assets/fonts/`
  with `OFL.txt` beside them.
  - For the share viewer, the files must also be listed in `browserResources`
    (`scripts/build-public-share-viewer-artifact.mjs:11-43`).
  - Keep the system fallback stack.
- **Prototype A uses the system stack with no bundled font** (zero payload; the KISS baseline):
  `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` and
  `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. It drops today's un-bundled `Inter` declaration.
- **Not allowed**:
  - General Sans (the website font) and other Fontshare fonts, because the ITF licence forbids redistribution;
  - SF Pro files (referring to the system font by `-apple-system` is fine);
  - any commercial face.
- **Design canvas vs production**: prototypes may load the chosen fonts **from Google Fonts on the design canvas only**.
  Production cannot: both CSPs forbid remote fonts.
- **Budget**: ≤ 3 families per prototype. Variable fonts are preferred, with a Latin subset plus a system fallback for
  non-Latin titles. Aim for ≤ ~300 KB of total font payload.
- **Licence check**: 04 §5 lists every font named in this brief as OFL. Verify the `OFL.txt` in each release before
  bundling.

### 2.7 Share viewer CSP and host limits (the page must be designable within these)

The CSP is:

```
default-src 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none';
script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'none'; form-action 'none'
```

Consequences for design:

- **No remote anything**: no remote fonts, images, video or audio, embeds, forms or network.
- **No inline `<script>`**, so the theme must be **CSS-first**, via `@media (prefers-color-scheme)` on the tokens. That
  fixes the flash of the wrong theme.
- **No `localStorage` or cookies** (`main.js:5-14`), so there is **no remembered theme toggle**. The viewer follows the OS
  only.
- **Old shares keep their old look.** Published shares pin their viewer artifact, so a redesign reaches only new shares.
  No shares exist yet (Gate C), which makes *now* the cheapest moment to change the look.
- **Phone**: use `100dvh`, not `100vh` (this breaks a branch pin, §2.3). Make the page `touch-action: pan-y` or give it an
  explicit graph mode, so the page can scroll.
- **OG image**: it must be a **1200×630 PNG** with its content inside the centred 1200×600 safe area. The SVG stays as the
  source only.
- The desktop CSP is stricter (`style-src 'self'`, no inline styles in static markup). One set of bundled font files can
  serve both surfaces.

### 2.8 Brand

- **The logo is the three-slash mark** (Vishal, 2026-10-03; supersedes "the logo stays unchanged"). The app mark is three
  slashes at an 18° lean on an ink tile; spread, they become the wordmark RE / A \\ ƎЯ, drawn in strokes at the slash weight
  from Bricolage Grotesque 700 metrics (design A of the Round 3 logo canvas). `desktop/renderer/src/relayer-mark.js` owns
  the geometry; `scripts/build-relayer-logo-assets.mjs` writes the committed icon and tile-mask SVGs from it.
  - The sidebar and new-thread hero lockups are the transition: each rests on the mark, hovering it spreads the mark into
    the wordmark and leaving folds it back (700 ms each way, instant under reduced motion); the collapsed icon rail has no
    room for the word and ignores hover. Provider-setup and account tiles stay the mark, drawn in the theme's text colour
    through a luminance mask so the page shows through the slashes.
  - The skateboarder PNG-in-SVG is retired from the product; relayerlabs.ai is out of scope here.
- **Brand colours are respected, not necessarily used as UI accents**: cream `#FAF2E6` and deck `#D74326`.
  - Palettes A, B and D extend them. The reel's `#F54731`/`#F44731` is within about 3° of hue of the deck, and B's
    marshmallow `#FDFAEA` is close to the cream.

---

## 3. Canonical object types, states and sample content (identical in all four prototypes)

### 3.1 Object types every prototype must visually encode

| Object | One-line meaning | Where it must appear |
|---|---|---|
| **Project** | An authorised local folder (often a Git repo) that owns threads. | Sidebar row (marker + name); scope line |
| **Thread** / **Chat** | A saved graph of completions. A Chat is a thread with no folder. | Sidebar entry; **header title** |
| **Turn (interaction)** | One user event that called Complete. It is either a typed prompt or an invoke-created turn (marked "from *action* on *node*"). | Prompt card + turn pager |
| **Connected nodes** | Nodes attached to this turn as context. | Prompt-card pill (`⌘ N`, opens a popover) |
| **Layer** | One screen of the graph. The root is "Response"; child layers are opened from a node. | Canvas + breadcrumb (hidden at root-only) |
| **Working (current) layer** | A layer the running turn has advanced but not yet returned. It is **not final**. | Canvas frame + tag **inside the canvas, top-left** **[PD]** |
| **Live view** | The view follows the working layer until the user navigates away, then it is pinned (ADR 0008, `model.js:47-58`). | X6 specimen "Viewing an earlier layer · Jump to live" **[PD]**, copy illustrative |
| **Node** | An icon + title object with markdown or authored details. | Canvas; inspector heading |
| **Node family** | A presentation-only grouping of node icons into 6 coloured families plus neutral (§3.3). Nodes carry no type field of their own; the family is derived from the icon. **[PD]** | Canvas colour channel; the inspector heading repeats the node's icon in its family treatment. The inspector caption keeps the raw `kind` (for example "concept"), as today. |
| **Edge** | An undirected relationship between two nodes in a layer. | Canvas line |
| **Action: opens a layer** | Navigate (expand or reference, deliberately not distinguished). It opens another layer. | Inspector pill; one generic canvas mark **[PD]** |
| **Action: invoke** | Starts a follow-up turn from this node. States: ready, invoked (disabled), retry ("Retry <label>"), resolved (becomes navigational), unavailable in accepted detail. | Inspector card; canvas mark **[PD]** |
| **Action: input** | Asks the user for text or a single/multi choice before the next Send. States: staged, committed, invalid, pending, locked, loading. | Inspector fieldset; canvas mark **[PD]** |
| **Attach context (+)** | Adds the node (with an optional note) to the next message. It is always the last control in the row. | Inspector; composer context pill (solid border, with a count) |
| **Input attachment** | A committed input answer that will go with the next Send. | Composer pill (dashed border) |
| **Node Details** | The inspector body: legacy markdown or an authored HTML/CSS page. | Inspector |
| **Semantic child completion** | A separate completion started from a node's action by agent-authored code. Its lifecycle shows as the node's lifecycle badge. | Canvas badge **[PD]** |
| **Approval request** | The harness is paused for a permission decision (command, file change, network). Queue "1 of N"; history rows. | Approval dock (replaces composer); sidebar mark **[PD]** |
| **Environment snapshot** | Git or folder facts for a project thread: branch, changes `+N −M`, untracked files; loading, unavailable, stale. | Inspector top (collapsible) |
| **Model selection** | "Family · Model" (for example "Codex · GPT-5.6-Terra"). The harness is under the Advanced tab. | Composer button + picker |
| **Review / read-only mode** | Eval review, imported threads and the share viewer: nothing can be mutated. | Composer message "Read-only evaluation result" (`view.js:100`) |
| **Share snapshot** | A frozen, read-only public copy that contains accepted turns only. | Share viewer |

### 3.2 States every prototype must visually encode

Every state below gets a **text label** and a **glyph**. Glyphs come from Lucide chrome icons *outside* the node-icon
allowlist wherever possible. The exception is the Stopped ■, which is Lucide `square` (also a Neutral node icon): keep it,
because the PRD uses the square, but draw it **only inside a 16px badge disc**, never in a node's icon well.

| Level | State | One-line meaning | Glyph |
|---|---|---|---|
| Turn | **Waiting** | Submitted; the harness has not started producing. | `hourglass` |
| Turn | **Running** | Complete is active and may advance a working layer. | `loader-circle` (animated; static under reduced motion) |
| Turn | **Needs approval** | The harness is paused for the user's permission decision. | `hand` |
| Turn | **Stopping…** | Stop was requested; waiting for the runtime to confirm. | ■ inside a spinning ring (neutral) |
| Turn | **Stopped** | The user stopped it. The last working layer is kept but **not accepted**; send a follow-up to continue. | ■ (neutral) |
| Turn | **Failed** | Ended with an error; the reason is shown and retry is available. | `octagon-x` (danger) |
| Turn | **Cancelled** | Ended without a result (not the same as Failed). | `ban` (neutral) |
| Turn | **Accepted** | GraphComplete validated and accepted the response layer. | `check` |
| Record | **Draft** | Authored but not yet accepted (node, edge, layer or action). | dashed outline + "Draft" caption |
| Record | **Accepted** | Part of the graph. Drawn as **Default (solid)**; acceptance itself shows only at turn/layer level (§2.1). | solid outline + fill |
| Record | **Stopped** | A discarded orphan layer. **Never rendered.** | — |
| Layer | **Working · not yet accepted** | The running turn's current layer. | dashed canvas frame + tag **[PD]** |
| Layer | **Stopped · last working state** | The layer kept from a stopped turn. | neutral solid frame + tag |
| Layer | **Failed · last working state** | The layer kept from a failed turn. | neutral solid frame + tag with `octagon-x` |
| Node | **Child running** | A semantic child completion started from this node is in progress. | running badge (`loader-circle`) + optional orbiting arc + "Running" caption **[PD]** |
| Node | **Child stopped** | That child was stopped. The node itself is ordinary content: it **keeps its family colour**. | ■ badge + "Stopped" caption **[PD]** |
| Node | **Child failed** | That child failed. | `octagon-x` badge + 2px danger outline + "Failed" caption **[PD]** |
| Node | **Default / hover / selected / keyboard focus** | Hover: stroke → `--edge-strong`. Selected: the accent selection ring, fill unchanged. Focus: a `--text` ring outside everything. | — |
| Node | **Opens a layer (N)** | The node has navigate actions. | stacked-offset silhouette + `›N` at card and detail tier |
| Node | **Invoke ready / invoked / retry** | The node has a follow-up action. "Retry <label>" appears only after an invocation ended unresolved (`action-invocation-state.js:18-23`, `workspace.js:1301`), and never while a turn is running. | ▷ hollow / ▷ filled / `refresh-cw` |
| Node | **Asks for input (unanswered / answered)** | The node needs the user's input. | `text-cursor-input` hollow / filled dot |
| Node | **Attached as context** | The node is attached to the next message. | `paperclip` |
| Node | **Has comments (N)** (Eval review only) | The node has review comments. Edges can carry a midpoint comment badge too. | count bubble |
| Node | **Dragged (pinned for this view)** | The user moved it; the change is local only. | small pin dot, shown on hover only |

**Badge slots are fixed**, so position carries meaning (the Houdini/Ogma pattern). Badges are 16px discs with 10px glyphs.

| Corner | Carries |
|---|---|
| top-right | comments |
| bottom-right | lifecycle: running, stopped, failed |
| top-left | action marks: invoke, input |
| bottom-left | attached as context |
| behind the node (stack offset) | opens a layer |

Prototype B places its badges on the pill's **exterior** corners, in the same four positions.

**Badge colours (all prototypes)**:

| Badge | Disc | Glyph |
|---|---|---|
| Running | A, D: `--field` + 1px `--border-strong`; B, C: `--running` | A, D: `--text`; B: ink `#1B1B17` (4.99); C: white (4.86) |
| Stopped | `--field` + 1px `--border-strong` | ■ in `--text-muted` |
| Failed | `--danger-strong` | white `octagon-x` |
| Invoke / input / attached | `--field` + 1px `--border-strong` | `--text` |
| Comments | `--accent-solid-alt` (C: `--accent-solid`) | white count |

**Shared state grammar.** All four prototypes use the same *channels*, so a comment on one state carries over to every
generation:

| Meaning | Channel |
|---|---|
| draft | dashed 1.5px outline (4/3 dash) + "Draft" caption; body hollow (canvas colour) in A, B and D; C keeps the card fill and adds a yellow highlighter behind the title. Text keeps full contrast; **never opacity** |
| running | running badge (bottom-right) + "Running" caption at card tier; plus one 90° arc orbiting the node, 1.4s linear, in `--running`. Under reduced motion: **badge only** (no static arc, which could be mistaken for a selection ring) |
| default (solid) | solid outline + filled body; no mark |
| child stopped | family colour kept + ■ badge in `--text-muted` on `--field` + "Stopped" caption |
| child failed | 2px `--danger-solid` outline + `octagon-x` badge (`--danger-strong` disc, white glyph) + "Failed" caption |
| selected | 2px `--selection-ring` ring at a **2px** canvas-coloured gap; the fill does not change |
| focus | 2px `--text` ring outside the selection ring |
| hover | node stroke → `--edge-strong` |

Prototypes differ in how they *express* these channels (ring vs tab vs tile, quiet vs loud), and in one gene of the grammar:
**the running ink** (§6.0 gene Q). A and D draw running in neutral ink (`--text`); B and C draw it in their accent, the
same hue as selection. This tests whether "running looks selected" in a still frame.

### 3.3 Node families: icon → family mapping (presentation-only **[PD]**)

There are six coloured families plus neutral. **Status-like and verification icons stay neutral**, so a node's hue never
looks like a state (green means accepted).

| Family | Meaning | Icons (all 116 allowlist names are assigned; full list in Appendix A) |
|---|---|---|
| **F1 Document** | Writing, files, references | file, file-text, scroll-text, book-open, library, clipboard, pencil-line… (13) |
| **F2 Code** | Source, repos, components | code, terminal, braces, git-*, folder-git-2, package, puzzle… (18) |
| **F3 Data** | Stores, tables, structure, layouts | database, database-backup, table, list, layers, layout-template, panels-top-left… (23) |
| **F4 Systems** | Machines, services, infra, security | server, cpu, cloud, smartphone, globe, plug, settings, lock, key… (21) |
| **F5 People & agents** | Humans, bots, conversation | user, users, bot, messages-square, mail, send… (8) |
| **F6 Reasoning** | Ideas, strategy, search, process | brain, compass, sprout, zap, route, workflow, search, star… (10) |
| **Neutral** | Signals, flow, fallback | alert-*, check-circle, shield-check, info, help-circle, link, arrow-*, loader, play-circle, `circle` fallback… (23) |

Each prototype's family colours are in its §6 table. They were re-searched for this final brief
(`tmp/final-brief-cat.mjs`) against each prototype's **final** reserved colours, with these rules in both themes:

- **Contrast**: ≥ 3:1 on every ground the family mark sits on (A: node fill, surface and canvas, including the dark
  charcoal canvas for hollow drafts; B: pill fill and canvas; C: card fill; D: canvas and surface).
- **Solid fills** (B discs, D tiles) carry the white or ink (`#1B1B17`) icon printed in the table, at ≥ 4.5:1.
- **Distance from reserved colours**: ΔE ≥ **10** (A: **12**, because its type mark is a thin icon stroke) from the accent,
  the selection ring, a hued running colour, every danger token (solid, strong and text), warning, success, and each
  prototype's special signals (B lime, C yellow).
- **Hue gaps**: ≥ **30°** from the prototype's selection/interaction hue; ≥ **20°** from the success, warning and danger
  hues (D: ≥ 30° from danger, because D keeps red for failure only and its tiles are large).
- **Between families**: ≥ 20° of hue apart, maximising the smallest normal-vision and CVD ΔE (report 08's metric).

**Hard rules for type colour.**

1. A coloured icon stroke (A) or 4px tab (C) sits only on plain `--node-fill` (or, in A's hollow draft, on the canvas).
   Minimums in the final sets: A 3.03 (dark F5 on charcoal, drafts only; 3.36 on node fill), C 3.19.
2. A solid family fill (B, D) carries the icon colour printed in its table. Minimum 4.51 (B F6).
3. **A tinted fill (colour-mixed toward the node fill) with a coloured icon is forbidden.** In the gen-1 check, 12 of 36
   palette/theme/slot pairs fell below 3:1. Tints are decorative only; an icon on a tint uses `--text` (this is C's tile).
4. Overflow slots 7–8 in `palettes.json` are **not used**.
5. **Selection never changes the fill under a family mark** (§2.5).

### 3.4 Canonical sample content (use exactly; the same in every prototype)

Strings are either **real** (found in the repo; source given) or **illustrative** (written for this brief, derived from
the real Lantern prompts). Draw them exactly; the labels here are for honesty, not for the artboards.

The Lantern case is the recursive-graph-memory Eval case
(`packages/eval-runner/src/cases/recursive-graph-memory.ts:10-37`); its fixture is `test/support/lantern-2x2-fixture.mjs`.

**Sidebar**

- **New thread** `⌘N`
- **CHATS** (all real, `docs/prd/assets/product-walkthrough.html:1309-1416`, `scripts/capture-*-evidence.mjs`):
  - Graph search design
  - Product idea
  - Show the deterministic task system.
  - Stop and retry
- **PROJECTS**:
  - ▾ **relayer-graphcomplete** (real project)
    - **Lantern launch readiness** (real; active; Running mark **[PD]**)
    - Environment rail verification (real, `scripts/capture-environment-rail-evidence.mjs`)
    - Send-to-display flow (real title from the PRD walkthrough; Failed mark **[PD]**)
  - ▾ **h3** (illustrative project name; the h3 Eval case runs "in this h3 checkout")
    - h3 · status-code sanitization (real, `packages/eval-runner/src/project-cases/h3.ts:66`; Needs approval mark **[PD]**)
- **Footer**: Settings · Account · update circle (shown, "update available").
- Sidebar marks cover **Running, Needs approval and Failed only**. Stopped and accepted threads get no mark, and drafts
  never get one. Marks are 12px glyphs at the row's right end: Running `loader-circle` in `--running` (A and D: `--text`;
  B rose 3.30 on paper; C cobalt), Needs approval `hand` in `--warning-text`, Failed `octagon-x` in `--danger-text` (both
  ≥ 4.5 on the sidebar). D's olive sidebar uses ink glyphs on `--surface` discs instead (§6.4).
- The collapsed project row (▸) is shown on X1 as a sidebar-row specimen.

**Thread header**

- Back / Forward.
- Title: "Lantern launch readiness".
- Scope line: "relayer-graphcomplete · Ask for approval · Codex Basic" ("Codex Basic" is real,
  `crates/relayer-app-server/src/storage/sqlite/migrations/0005_product_model_catalog.sql`).
- ••• Conversation settings.

**Prompt card (Turn 3)**

- Prompt text only (no eyebrow): "A pilot incident interrupted credential rotation on seven devices; two rolled back
  successfully but retained stale permission grants…" (real, two lines max).
- Connected-nodes pill: `⌘ 1` (the covenant from Turn 1 is attached as context).
- Pager "Turn 3 of 3" and the **Running** pill.

**Turns**

| Turn | Prompt (first line, real) | State |
|---|---|---|
| 1 | "Prepare a decision brief for a six-week private beta of Lantern, a fictional macOS desktop agent for local developer tools." | Accepted |
| 2 | "New constraints: each device can retain only one last-known-good build, 12% of testers may be offline for 72 hours…" | Stopped |
| 3 | "A pilot incident interrupted credential rotation on seven devices…" | **Running** (current) |

**Canvas: Turn 3 working layer** (root layer, so the breadcrumb is hidden; the canvas tag top-left reads "Working · not yet
accepted"). Placements are normalised 0–1 and projected into the 960×640 layout world (`graph-layout.js:73-84`). Use them in
all prototypes.

| id | Title | Icon | Family | Canvas state | x, y | Source |
|---|---|---|---|---|---|---|
| N1 | Offline recovery covenant | scroll-text | F1 Document | default; **SELECTED** (Node Details open); opens a layer (›2); has invoke + input marks | 0.42, 0.22 | real title (fixture `:69`) |
| N2 | Constrained recovery revision | file-text | F1 Document | default; opens a layer (›1) | 0.40, 0.72 | real title (fixture `:69`) |
| N3 | Red-team stop condition | route | F6 Reasoning | **CHILD RUNNING** (semantic child "Red-team stale-grant challenge") | 0.72, 0.30 | real title and child label (fixture `:69`, `:105`) |
| N4 | Named owners, weeks 1–6 | users | F5 People & agents | **DRAFT** (being authored) | 0.88, 0.64 | illustrative (Turn 3 prompt: "named owners for each of the six weeks") |
| N5 | Last-known-good build | database-backup | F3 Data | **CHILD STOPPED** | 0.64, 0.84 | illustrative (phrase from the Turn 2 prompt and the fixture detail) |
| N6 | Stale permission grants | key | F4 Systems | **CHILD FAILED** | 0.14, 0.44 | illustrative (Turn 3 prompt: "retained stale permission grants") |

Edges (undirected): N6–N1, N6–N2, N1–N3, N2–N5, and N3–N4 (**draft edge**, dashed).

The answers the rubric expects (§7): **N1 and N2 share a family** (Document; different icons); N4 is draft; N3 is running;
N5 is stopped; N6 is failed; N1 is selected; the layer is **working, not accepted**.

**Node Details (N1)**

- Heading: N1's icon in its family treatment; caption `concept` (the fixture's `kind`, 11px, `--text-muted`); title
  "Offline recovery covenant".
- Body:
  > Interrupted updates roll back to the last-known-good build and stale permissions are revoked before relaunch.
  > - Applies to the 12% of testers who may be offline for 72 hours
  > - Rotation stays paused on the seven affected devices until rollback reports healthy

  The first sentence is real (fixture `:71`); the two bullets are illustrative.
- Actions, in this order:
  1. pill "Supporting brief 1" (navigate; opens a layer) — real label (fixture `:90`);
  2. pill "Supporting brief 2" (navigate; **drawn identically** to 1) — real label;
  3. card "Compare approaches", description "Lay out the tradeoffs before choosing.", icon `git-compare` (invoke;
     **disabled while Turn 3 runs**) — real (`packages/harness-host/src/implementations/codex-basic.ts`);
  4. text input "Review note", placeholder "Add a review note" (input; unanswered) — real
     (`docs/evidence/issue-371-visual-node-details/`);
  5. **+** last.
- The Environment section is collapsed to one row at the top of the inspector: "Environment · codex/issue-128-environment-rail
  · +16 −33 · Untracked 0 files · Local snapshot" (real, `docs/prd/assets/evidence/environment-rail/manifest.json`). The
  diff counts use `--diff-add` / `--diff-del` (§6).

**Composer**

- Placeholder "Follow up…" (real, `view.js:100`; disabled while running; placeholder in `--text-muted`).
- Model button "Codex · GPT-5.6-Terra", immediately before the Stop control.
- Stop control in the running state (neutral).

**Turn popover** (X6, dark): the three rows above, 52px each, with state glyph + label; the current row is marked.

**Model picker** (X6, light):

- Tabs: Model | Advanced.
- Family: Codex.
- Options: GPT-5.6-Sol · GPT-5.6-Terra ✓ · GPT-5.6-Luna · Daybreak Blue · GPT-5.5 (real,
  `docs/prd/assets/evidence/model-picker/manifest.json`). Each has the provider caption "Codex" and a 44px minimum row.
- The Advanced tab (optional inset) shows "Harness · Codex Basic · Pinned for this thread" (real, `model-picker.js:264`).

**Approval specimen** (X1):

- Title "Allow npm test"; reason "The deterministic fixture requested npm test." (real template,
  `packages/eval-runner/src/fixtures/approval.ts:102-103`).
- Scope "Run npm test in ~/ProjectsDev/relayer-graphcomplete for this live harness session." (illustrative path).
- Buttons: Deny / Approve once / Approve always (this session) (real, `view.js:92-94`).

**Messages** (real)

- Stopped notice: "Stopped. Send a follow-up to continue." (`crates/relayer-app-server/src/storage/sqlite/stops.rs`)
- Failure: "The selected model could not complete this turn. Choose an available model and send again."
  (`interaction-failure-model.js`)

**Share snapshot** (the same thread after Turn 3 was accepted; the stopped Turn 2 is excluded):

- Share title: "Lantern launch readiness" (the share dialog asks the user to type a title; here they reused the thread
  title).
- Meta line **[PD]**: "Read-only snapshot · Shared Sep 27, 2026 · relayer-graphcomplete". ("Read-only snapshot" matches the
  branch's redaction caption "Read-only snapshot · known secrets and paths removed", 03 §3.)
- Pager: "Turn 2 of 2".
- Layer: the same six nodes, all default (solid). No draft, running, stopped or failed marks: the children settled before
  acceptance. Same edges, with N3–N4 now solid.
- N1 is selected, with Node Details open. Its invoke card and input are inert, because the viewer executes nothing.
- Download card: "Relayer for Mac"; pitch "Explore this thread, then build your own."; "Download". Do **not** draw "Also for
  Windows": it is in main's PRD, but the branch removed it and its tests forbid it (PRD drift, §8.1).
- **Landing state** (X6): "Turn 1 of 2", a single node "Offline recovery covenant" (`scroll-text`; the fixture uses `box`),
  nothing selected, the "About this snapshot" card. Turn 1's real layer is exactly one node (fixture `:81-83`).

---

## 4. Screen inventory per prototype (six artboards each, 24 in total)

Every prototype delivers the same six artboards in one row, in this order:
`<Letter>1 System`, `<Letter>2 Desktop dark`, `<Letter>3 Desktop light`, `<Letter>4 Share web`, `<Letter>5 Share phone`,
`<Letter>6 Secondary states`. The letter is the prototype, so comments can cite, for example, "C3".

**Theme assignment is the same for all four**: X2 dark, X3 light, **X4 light**, **X5 dark**. Light/dark parity is judged on
X2 vs X3 (same scene, same size).

### 4.1 `X1 System sheet` (1440 wide, height as needed; both themes side by side)

1. **Header**: prototype name, one-sentence hypothesis, the three reel chips with their hex, and the logo on its cream
   tile on both theme grounds.
2. **Token swatches**, light and dark:
   - the surface ladder (bg, sidebar, surface, field, overlay, hover, selected);
   - text (text, muted, faint);
   - borders (border, border-strong);
   - accent (solid, alt, soft, text) and the selection ring; focus (= `--text`);
   - running;
   - the prototype's special signal (B lime, C yellow);
   - status (solid, soft, text for success, warning, danger, draft);
   - graph (canvas, grid, edge, edge-strong, node-fill, node-stroke, draft outline);
   - diff (add, del).
   Each swatch is labelled with its hex and its key contrast ratio.
3. **Type specimen**: the scale with px, line-height and weight; font names; sample strings from §3.4; the 11px floor shown.
4. **Spacing (4px grid), radius family and elevation** (how surfaces rise in each theme).
5. **Node anatomy** at the three zoom tiers (overview < 0.6×, card 0.6–1.4×, detail > 1.4×), in both themes.
6. **Family legend**: F1–F6 plus Neutral, each with two sample icons and the family name, in both themes. Include the
   greyscale rendering beside it to prove the icon still carries identity.
7. **State matrix**: one node shown in default, hover, selected, focus, selected+focus, draft, child running, child
   running (reduced motion = badge only), child stopped and child failed. Next to it, the affordance badges: opens a layer
   ›2; invoke ready, invoked and retry; asks for input, unanswered and answered; attached; comments 3.
8. **Layer frames**: working / stopped (retained) / failed (retained) / accepted (final).
9. **Status pills**: Waiting, Running, Needs approval, Stopping…, Stopped, Failed, Cancelled, Accepted.
10. **Controls**:
    - primary, secondary, ghost and danger buttons;
    - **Send / Stop / Stopping** (the neutral Stop with its 10px square);
    - input (with its `--text-muted` placeholder), select and model button;
    - context pill (solid, with count) and input pill (dashed);
    - the approval dock specimen;
    - sidebar rows in default, hover, selected (with leading bar), focus, and the collapsed project row (▸), plus the
      Running, Needs approval and Failed marks **[PD]**.
11. **Edge specimens**: default, draft (dashed), selected-incident (edge-strong), dimmed non-neighbour, and an edge with a
    midpoint comment badge (Eval only).
12. **OG image**: the 1200×630 PNG composition shown at 600×315, inside a light and a dark unfurl frame
    (Slack/iMessage-like).
13. **Contrast table** of the key pairs, in both themes.
14. **"Product decisions shown here"** box listing every [PD] element the prototype draws, and **"Test pins this
    prototype breaks"** box (from §2.3 and §6.x).

### 4.2 `X2 Desktop dark` (1440×900) and `X3 Desktop light` (1440×900)

Both show **exactly the same scene**, pixel for pixel apart from colour, so parity can be judged directly. No popover is
open in either (popovers are on X6).

- Sidebar with the chats and projects from §3.4 (the Lantern thread active, with its Running mark).
- Header: back/forward, title, scope line, •••.
- Prompt card for Turn 3: prompt (two lines max), connected-nodes pill `⌘ 1`, pager "Turn 3 of 3", **Running** pill. The
  prompt text starts at the same x as the (hidden) breadcrumb row and the canvas's left content edge.
- No breadcrumb (root layer).
- The canvas at **Fit**, showing the true zoom value in the zoom control (expect about 95–110%; Fit is capped at 1.25×
  **[PD]**; B fits into the canvas area its floating panels leave uncovered). It shows:
  - the "Working · not yet accepted" tag top-left inside the canvas, and the working-layer frame;
  - N1 **selected** (selection ring);
  - N3 **child running** (badge, caption, arc);
  - N4 **draft** (dashed, with its dashed edge);
  - N5 **child stopped** (■ badge, family colour kept, "Stopped");
  - N6 **child failed** (danger outline, `octagon-x` badge, "Failed");
  - N1 and N2 with the **opens a layer** stack.
- Hint pill and zoom controls.
- Inspector: the collapsed Environment row, then Node Details for N1 with its actions and **+**.
- Composer: placeholder, model button "Codex · GPT-5.6-Terra", neutral **Stop**.

### 4.3 `X4 Share viewer, web` (1440×900, **light**)

- **No sidebar, no composer.** Gutters of 16px on all sides; today's left gutter is 0.
- Header (the `.thread-header` "thin public bar"): share title "Lantern launch readiness", the meta line, and no
  back/forward arrows (they are dead controls in review mode).
- Download card (the only branding): logo 32–40px on its cream tile, "Relayer for Mac", the pitch, and Download in the
  product primary style.
- Prompt card for shared turn 2 (desktop Turn 3's prompt), pager "Turn 2 of 2".
- Canvas: the accepted final layer from §3.4, with no working tag. Use the prototype's accepted-layer treatment (quiet, or
  lime in B).
- A compact family key **[PD]** at the canvas's bottom-left: only the families present (Document, Data, Systems, People,
  Reasoning), each as its colour mark + name, 12px `--text-muted`. It lists no states, because a snapshot holds accepted
  content only.
- **Node Details open** for N1. The invoke card and input are inert.
- The share layout must not leave an empty 340px column. Either the card sits above Node Details, or the card becomes a
  compact "About this snapshot" block when nothing is selected.

### 4.4 `X5 Share viewer, phone` (390×844, **dark**)

390×844 is a choice (iPhone 12–16 size); the layout must also hold at 375×812, the size of the branch evidence.

Exact vertical budget (sums to 844):

| Band | Height | Content |
|---|---|---|
| iOS safe area, top | 47 | — |
| Header | 48 | title on one line (15/600) + meta line (12px) |
| Download card | 56 | logo 28, "Relayer for Mac", Download button 36px visual inside a **44px hit area** |
| Prompt card | 76 | prompt clamped to 2 lines at 15px; pager on the same row with 44px targets |
| Gaps | 24 | 3 × 8 |
| Graph | **377 (44.7%)** | full-bleed; all 6 nodes |
| Bottom sheet at **peek** | 216 (25.6%) | includes the 34px home-indicator zone; shows the handle, N1's title, caption, first two body lines and the first action |

- The page uses `100dvh`, `touch-action: pan-y`, and is not a scroll trap.
- **Phone graph rule (all four prototypes)**: on viewports narrower than 480px, Fit uses **16px padding**. The six-node
  layer then fits at about 0.5× (it is about 707–727 world px wide), which is the **overview tier**. Draw overview tokens,
  **label only the selected node** (13/600 with a halo), and show a tap-to-reveal label tooltip on one other node as a
  specimen.
- Zoom controls are 44px targets. The hint is hidden below 480px, so it no longer collides with the zoom control.
- A 44px "Key" button **[PD]** at the graph's top-left opens the family key.
- The sheet snaps to peek (216), 50% (422) and 85% (717). It has a 36×4 drag handle. In the sheet: title 20px, body
  16px/1.55, actions 44px tall, **+** last. The 85% state is drawn on X6.

### 4.5 `X6 Secondary states and insets` (1440 wide, height as needed; both themes where noted)

1. **Turn popover** (dark), 480×400 frame, anchored to a copy of the prompt card: the three turn rows, 52px each, the
   current row marked.
2. **Model picker** (light), 480×440 frame, opened from the composer (Model tab, Codex family, GPT-5.6-Terra checked).
3. **Share landing** (light), a real-size **720×450** frame: "Turn 1 of 2", the single node "Offline recovery covenant",
   nothing selected, the "About this snapshot" card. This shows the 1-node Fit cap at 1.25× and answers the stranger's
   5-second question.
4. **Phone sheet expanded** (dark), 390×844: the sheet at 85% with N1's full Node Details.
5. **Share dialog** (desktop, 480 wide, both themes): "Share this thread" (title step; "Share title"), "Creating link…",
   "Link ready" (read-only URL + Copy + ×; caption "Read-only snapshot · known secrets and paths removed"),
   "We couldn't create the link" (with a Reference), "Daily share limit reached". Strings are from the branch (03 §3).
6. **Settings › Appearance** (both themes): Dark / Light / System (System is **[PD]**).
7. **New-thread view** (light): folder control, permission picker ("Ask for approval / Approve for me / Full access" with the
   Full-access disclosure), model button, logo hero.
8. **Secondary-states strip** (both themes, one compact specimen each):
   - live view pinned: "Viewing an earlier layer · Jump to live" **[PD]** (copy illustrative);
   - waiting canvas: three dots, then "This interaction has no accepted graph yet." (`workspace.js:4307`);
   - failed before a graph: "This interaction failed before producing an accepted graph: <reason>" (`workspace.js:4305`);
   - read-only composer: "Read-only evaluation result" (`view.js:100`);
   - approval queue "1 of 2" plus history rows "Approved for this session", "Denied", "Expired" (`approval-model.js`);
   - environment stale: "Refresh failed. Showing the last local snapshot." with its warning timestamp (`workspace.js`);
   - update states: "Downloading update · 42%", "Update ready to install", "Update failed" (`update-indicator-model.js:11-13`);
   - onboarding coach-mark in the new tokens (breaks the tutorial pins, §2.3);
   - input control states: staged, committed ✓, invalid, pending, locked, "Loading committed inputs…" (`workspace.js:4541`);
   - action states: ready, invoked (disabled), "Retry Compare approaches", resolved (navigational), unavailable in accepted
     detail;
   - retained layer tags: "Stopped · last working state" and "Failed · last working state";
   - a share load-error card: today's "couldn't be loaded" state (03 §6.2), redesigned with the mark and the install
     CTA (exact copy illustrative); a 404 page is owned by the private service repo, so any 404 design is a cross-repo
     **[PD]**.

---

## 5. Sizing recommendations (numbers)

"Common" values apply to all prototypes. The A–D columns are each prototype's choice within the allowed range.

| Element | Common rule / floor | A | B | C | D |
|---|---|---|---|---|---|
| Base UI font | 13–14px; never below 13px for body text | 13 | 14 | 13 | 14 |
| Type scale (px) | ≤ 7 sizes; floor 11 | 11/12/13/15/18/24 | 12/13/14/16/20/28 | 11/12/13/15/18/22/28 | 12/13/14/16/20/28/40 (display serif) |
| Line height | body 1.45–1.55; UI labels 1.25–1.35 | 1.45 | 1.5 | 1.45 | 1.55 |
| Weights | 400/500/600 (700 only for display) | 400/500/600 | 400/600 + display 700 | 400/600 | 400/500/600 + serif 600 |
| Micro-label (caps) | 11px/600 uppercase, +0.06em, `--text-muted` | ✓ | 12px | ✓ | ✓ (uppercase, not small caps) |
| Spacing grid | 4px (4, 8, 12, 16, 20, 24, 32, 48) | ✓ | ✓ | ✓ | ✓ |
| Radius family | 3 steps + pill | 6/10/14 | 10/16/24/999 | 6/8/12 | 2/6/10 |
| Sidebar width | 224–272; collapsed 56; ≤ 980px → 216 | 232 | 248 | 248 | 248 |
| Sidebar row height | ≥ 28 | 28 | 36 | 32 | 34 |
| New-thread button | 32–40 tall | 32 | 40 | 36 | 36 |
| Header + prompt card | ≤ 124 total (today 176) | header 44 + prompt strip 44 | header 44 + floating prompt card 64 (over the canvas) | header 48 + prompt card 72 | title row 36 + headline band 88 |
| Breadcrumb row | **40** (pinned); segments ≥ 28 tall; hidden at root-only | ✓ | ✓ | ✓ | ✓ |
| Inspector width | 300–420 (authored content 260–420) | 320 docked; collapses when nothing is selected **[PD]** | 340 **floating**, fixed height **[PD]** | 360 docked, persistent **[PD]** | 368 docked (reading) |
| Unobscured canvas width at 1440×900 | ≥ 55%. Docked: 1440 − sidebar − inspector − 24; floating: 1440 − sidebar − (inspector + 2 × 12 inset) | 864 (60.0%) | 828 (57.5%) | 808 (56.1%) | 800 (55.6%) |
| ≤ 1100px window | Today the inspector stacks below the graph; a right overlay sheet (360) is **[PD]**; sidebar collapses at ≤ 980 | ✓ | ✓ | ✓ | ✓ |
| Node footprint at 1.0× | uniform size, never encoding importance | circle **40** + label right (max 176w) | pill **36h**, max 248w, disc 28 | card **208×56**, tab 4, tile 28 | tile **48** + label below (max 168w) |
| Node icon | Lucide, stroke 1.75 | 20, **stroke 2** (thin coloured strokes need the weight) | 18 in disc | 18 in tile | 22 |
| Node label | **screen-constant**, 11–15px, max 2 lines, halo on canvas | 13/600, 2 lines | 14/600, 1 line (ellipsis) | 13/600, 2 lines | 13/600, 2 lines, halo |
| Overview tier token | ≥ 24 | disc **24** | disc 28 | white chip 28 with its tab | tile 28 |
| Zoom | manual range 0.4–2.0 kept; **Fit capped at 1.25×** **[PD]**; Fit padding **48** desktop (today's value), **16** phone | ✓ | ✓ | ✓ | ✓ |
| Semantic zoom tiers | < 0.6 overview (no labels except the selected node) · 0.6–1.4 card · > 1.4 detail (text stays ≤ 15px; more content appears) | ✓ | ✓ | ✓ | ✓ |
| Edge | non-scaling stroke; clip at node box + 4px (and at the label box); hit area **18px** (today's value) | 1.5 straight | 1.5 gentle arc | 1.5 straight | 2.0 straight |
| Selection ring | 2px ring + **2px** canvas gap | ✓ | ✓ | ✓ | ✓ |
| Focus ring | 2px `--text`, 2px offset, outside the selection ring | ✓ | ✓ | ✓ | ✓ |
| Node badges | 16px disc, 10px glyph, fixed slots (§3.2) | ✓ | exterior corners | ✓ | ✓ |
| Desktop hit targets | ≥ 24 (min); icon buttons ≥ 28 | 28 | 32 | 28 | 32 |
| Canvas controls | zoom group 32 tall; buttons 32×32; zoom % 12px/500 tabular, 44w; hint 12px `--text-muted`, dismissible, auto-hides after the first pan | ✓ | 36 | ✓ | ✓ |
| Turn pager | 32 tall; popover rows 52 (pinned); 3 rows visible | ✓ | ✓ | ✓ | ✓ |
| Status pill | 24 tall, 12px/500, glyph 12 | ✓ | 28 (lime Accepted) | ✓ | ✓ |
| Composer | min height 56; textarea 40–160 auto-grow | docked 56 | floating 56, radius 24, max 760w | docked 56 | docked 60 |
| Send/Stop | 32–36 square; Stop glyph **10px** square (pinned) | 32 | 36 circle | 32 | 36 |
| Model button | 32–36 tall, max 240 wide, right before Send | 32 | 36 | 32 | 36 |
| Model picker | 360w; tabs 32; option rows ≥ 44 | ✓ | ✓ | ✓ | ✓ |
| Inspector body | ≥ 13px (desktop), 16px (phone) | 13/1.55 | 14/1.55 | 13/1.55 | 15/1.55 |
| Phone share | chrome ≥ 12px; body ≥ 15px; targets ≥ 44; sheet peek 216 / 50% / 85% | ✓ | ✓ | ✓ | ✓ |

**Where the prototypes may legitimately differ**: base size 13 vs 14; row height 28–36; widths within the ranges above;
radius family; node silhouette and label placement; docked vs floating panels; header and prompt-card styling.

**Where they may not differ**: the 11px floor, the contrast floors (and the 3.2 stroke margin), the Fit cap, screen-constant
labels, the 40px breadcrumb, the 52px turn rows, the 10px Stop square, the hit-target minimums, and the DOM order.

---

## 6. Four prototype directions (branch width 4)

### 6.0 The four stances at a glance (the "genome")

Each row is one gene. The next generation can cross genes over, for example "B's lime acceptance on C's cards", subject to
the dependency note below the table.

| Gene | **A · Nocturne "Orbit"** | **B · Surly "Sticker"** | **C · Apex "Index"** | **D · Small Things "Stamp"** |
|---|---|---|---|---|
| **P** palette | `#332E34` `#7779DF` `#F54731` | `#FDFAEA` `#E65979` `#C1E357` | `#9AB9C2` `#0C6FDC` `#FEFD15` | `#B9B864` `#D5E3FB` `#F44731` |
| **T** default theme | **Dark-first** (today's default) | **Light-first** (paper) | **System** (both equal) **[PD]** | **Dark-first editorial** (near-black olive with ice ink) |
| **N** node shape | Circle token 40px, label **right** | **Pill** 36px, 28px disc, label inside | **Index card** 208×56 + 4px type tab | **Stamp**: solid 48px tile, label below |
| **K** type-colour channel | Whisper: icon stroke colour only | Medium: solid disc | Structured: tab (+ decorative tint tile) | Loud: the whole tile |
| **Q** running ink | **Neutral ink** (`--text`) | Accent (rose) | Accent (cobalt) | **Neutral ink** (`--text`) |
| **S** density | Compact 13/28 | Comfortable 14/36 | Standard 13/32 | Reading 14/34 |
| **F** fonts | **System stack** (no bundled font) | Bricolage Grotesque + Figtree + DM Mono | Atkinson Hyperlegible Next + Mono | Fraunces + Instrument Sans + JetBrains Mono |
| **E** edges | Straight 1.5 | Gentle arcs 1.5 | Straight 1.5 | Straight 2.0 "print line" |
| **G** canvas | Dark: **charcoal poster canvas `#332E34`** + dots; light: dots | Flat paper, **no grid** | Light: **powder "blueprint" canvas** + dots; dark: dots | Flat paper + registration crosses every 96px |
| **R** accent rationing | Periwinkle = interaction and selection; red = failure only | Rose = interaction, selection and running; **lime = accepted** | Cobalt = interaction, selection and running; **yellow = not yet accepted** | **Colour belongs to content**: no chrome accent; blue = selection only; red = failure only |
| **L** layout | Compact: header 44 + one-line prompt strip 44; inspector collapses when empty **[PD]** | **Floating**: prompt card, inspector card **[PD]**, composer bar | Docked: header 48 + two-line prompt card 72; persistent inspector **[PD]** | Editorial: title row 36 + serif **headline band** 88; olive **sidebar block** in both themes; reading inspector |
| **V** elevation | Lighter surfaces, no shadows (dark); hairlines (light) | Soft shadows, floating cards | Hairlines, flat | Flat with 1px rules |

**Genes are not fully independent.** K depends on N (a tab needs a card); G depends on P (a poster canvas is a palette
swatch); R and Q depend on P (the accent must be free to carry running). Every crossover must re-run the family-colour check
(`tmp/final-brief-cat.mjs` with the new reserved set). Example of a crossover that needs changes: B's lime `#C1E357` on C
sits only ΔE 11.3 (CVD 8.2) from C's yellow `#FEFD15`, so two neighbouring yellows would mean opposite things (accepted vs
not accepted); C's yellow would have to go.

Shared by all four: the state grammar (§3.2), family mapping (§3.3), sample content (§3.4), and invariants (§2); **Stop is
always neutral**; focus is always `--text`.

Token notes for every table in §6.1–6.4:

- Values come from `palettes.json` unless marked **†**, which means changed in this brief (reasons in §8.2 and Appendix C).
- `--field` = `palettes.json` `raised`. The prompt card uses `--surface` with a 1px `--border` in both themes (B adds its
  shadow), because light `--field` is darker than the page and would read as sunken.
- `--stop-bg` = `--field` and `--stop-glyph` = `--text` in **every** prototype. This replaces `palettes.css`'s
  `--stop-* → danger` alias, which contradicts the PRD. The stopped notice uses the same colour as the Stopped pill text.
- Ink icon colour on family fills = `#1B1B17`.

---

### 6.1 Prototype A — **Nocturne · "Orbit"** (dark-first, compact instrument)

**Hypothesis.** A calm, dark, dense instrument reads the graph like a star chart and will feel fastest for daily power use.
Small circle tokens carry labels to the right on a charcoal poster canvas. Colour is spent almost entirely on meaning:
periwinkle is interaction and selection, running is neutral ink plus motion, and red means only failure. It is the closest
to today and bundles no font, so it is the cheapest to ship.

**Tokens (Palette A).**

| Role | Light | Dark | Notes |
|---|---|---|---|
| `--bg` | `#FAF7FA` | `#100F10` | neutrals tinted toward the charcoal hue (h321) |
| `--sidebar` | `#FAF7FA` | `#161517` | |
| `--surface` | `#FEFCFE` | `#161517` | inspector, cards, prompt card |
| `--field` | `#F2F0F3` | `#201D20` | composer field, chips, Stop background |
| `--overlay` | `#FEFCFE` | `#272427` | popovers (light adds a shadow) |
| `--hover` / `--selected` | `#EBE8EC` / `#E4E0E5` | `#272427` / `#2E2C2F` | rows only; selected rows add the leading bar |
| `--border` / `--border-strong` † | `#DBD8DC` / `#888589` (3.22) | `#393639` / `#757276` (3.23) | |
| `--text` | `#1B1A1C` | `#EFEDEF` | ≥ 13.3 / 11.9:1; also the focus ring |
| `--text-muted` | `#656366` | `#BBB8BC` | ≥ 4.56 / 7.05:1; placeholders |
| `--text-faint` | `#8E8A8E` | `#716D71` | disabled and decoration only |
| `--accent-solid` (+label) | `#7779DF` (+`#1B1A1C`, 4.61) | `#7779DF` (+`#100F10`, 5.09) | exact reel periwinkle; primary buttons, Send, Download |
| `--accent-solid-alt` (+label) | `#6A6BD0` (+white, 4.54) | same | small labelled controls, comment badge |
| `--accent-soft-bg` / `--accent-text` | `#EBEDFF` / `#5A5AB2` | `#1C1D39` / `#ADB3FF` | links; selected-row bar |
| `--selection-ring` † | `#7779DF` (3.54 on canvas) | `#7779DF` (3.53 on charcoal) | graph selection only |
| `--running` † | `--text` | `--text` | neutral ink (gene Q) |
| `--canvas-bg` † | `#FAF7FA` | **`#332E34`** (exact reel charcoal) | the graph only; dark chrome stays `#100F10` |
| `--canvas-grid` † | `#E4E0E5` (1.23) | `#433D44` (1.26) | dots every 24px; fade out below 0.6× |
| `--edge` / `--edge-strong` † | `#8D898D` (3.24) / `#666467` | `#7F7C80` (3.22) / `#B4B1B5` (6.26) | on the canvas |
| `--node-fill` / `--node-stroke` † | `#FEFCFE` / `#8D898D` (3.24) | `#201D20` / `#807C80` (3.23) | dark nodes sit slightly darker than charcoal (1.26:1); the stroke carries the edge |
| canvas labels | `--text` | `--text` (11.40 on charcoal) / muted `--text-muted` (6.76) | 2px `--canvas-bg` halo |
| `--draft-outline` | `--node-stroke` | `--node-stroke` | dashed |
| `--danger-solid` / `--danger-strong` / `--danger-text` / soft | `#F54731` / `#E1311C` / `#D5210B` / `#FFEBE7` | `#F54731` / `#E1311C` / `#FFA190` / `#3A1B16` | **red = failure only** (+ the logo deck) |
| `--success-solid` / text / soft | `#229F56` / `#007F3F` / `#DBFAE1` | `#3DB268` / `#68D98C` / `#102C19` | Accepted pill only |
| `--warning-solid` / text / soft | `#B47900` / `#956300` / `#FFEDD6` | `#CB8900` / `#F6AE37` / `#332105` | Needs approval |
| `--draft-solid` / text / soft | `#706573` / `#756977` / `#F2EFF3` | `#766A78` / `#C5B9C8` / `#272428` | working tag (8.14 in dark) |
| `--diff-add` / `--diff-del` † | `#007F3F` (5.01) / `--text-muted` + "−" | `#68D98C` / `--text-muted` + "−" | no red for deletions (one-red rule) |
| `--stop-bg` / `--stop-glyph` † | `--field` / `--text` (15.3) | `--field` / `--text` (14.3) | neutral (PRD) |
| window first-paint background | `#FAF7FA` | `#100F10` | mirror in `window.mjs:46` |

**Family colours** (icon stroke, 2px, on `--node-fill`; hollow drafts put it on the canvas). All † (A's whole set was
re-searched).

| Family | Hue | Light | Dark | Notes |
|---|---|---|---|---|
| F1 Document | 333 magenta | `#D35DC3` (3.36 fill / 3.23 canvas) | `#E870D7` (6.14 / 4.89 charcoal) | anchored near the charcoal hue |
| F2 Code | 213 cyan | `#00899E` (4.06) | `#00899E` (4.03 / 3.21 charcoal) | |
| F3 Data | 126 yellow-green | `#567500` (5.22) | `#99CC21` (8.75) | |
| F4 Systems | 240 blue | `#005884` (7.54) | `#00A9F7` (6.37) | 40° from periwinkle |
| F5 People & agents | 357 pink | `#970054` (8.42) | `#D24082` (3.81 / 3.03 charcoal) | |
| F6 Reasoning | 312 purple | `#8636AF` (6.51) | `#E3B6FF` (9.86) | |
| Neutral | — | `--text-muted` | `--text-muted` | |

Smallest pairwise ΔE: light 14.8 (F2/F4), dark 14.4 (F1/F5); CVD 7.4 / 7.8. Nearest reserved colour ≥ 12.0 ΔE. The global
search returns six unlabelled colours (its output file names them F1–F6 arbitrarily); they were assigned to families here
by meaning, keeping F1 on the charcoal-hue anchor and Code on cyan as in 08.

**Fonts.** The **system stack** (§2.6): SF Pro on macOS, Segoe UI on Windows, `ui-monospace` for code, scope line and kbd.
No payload, no licence work.

**Size scale.** 11/12/13/15/18/24 px. Base 13/1.45. Sidebar 232, rows 28, inspector 320.

**Node spec (Orbit).**

- **Body**: a 40px circle, `--node-fill`, 1.5px `--node-stroke` ring.
- **Icon**: 20px, stroke 2, in the family colour (neutral family: `--text-muted`).
- **Label**: to the **right** with an 8px gap; 13px/600 `--text`; max 176px, 2 lines; 2px `--canvas-bg` halo using
  `paint-order: stroke`.
- **Detail tier**: an 11px uppercase family name above the title, and a one-line excerpt in 12px `--text-muted`.
- **Overview tier**: a 24px disc with no label.
- **Badges** sit at clock positions: 1:30 comments, 4:30 lifecycle, 10:30 actions, 7:30 attached.
- **Opens a layer**: a second ring offset 3px down-right behind the circle, plus `›2` beside the label.

**Edge spec.** Straight, 1.5px, non-scaling, in `--edge`. Clipped at the circle radius + 4px *and* at the label box. Round
caps. Draft edges are dashed 4/3. When a node is selected, its incident edges go to 2px `--edge-strong`, and non-neighbours
dim to 40%.

**State encodings.**

| State | Treatment |
|---|---|
| Draft | dashed ring + hollow (canvas-coloured) circle; icon keeps its family colour (≥ 3.03 on charcoal); "Draft" caption |
| Child running | running badge at 4:30 (`--field` disc, `--text` `loader-circle`); a `--text` 90° arc orbiting on the ring, 1.4s; "Running" caption; reduced motion: badge only |
| Default (solid) | solid ring, filled; no mark |
| Accepted | turn/layer level only: pill `check` "Accepted" in `--success-text` on `--success-soft-bg` |
| Child stopped | family colour kept; ■ badge at 4:30; "Stopped" caption |
| Child failed | 2px `--danger-solid` ring replaces the stroke + `octagon-x` badge (`--danger-strong`, white glyph) + "Failed"; the **only** red on the canvas |
| Selected | 2px periwinkle ring at a 2px gap; fill unchanged |
| Focus | 2px `--text` ring outside the selection ring |
| Working layer | 1.5px dashed `--border-strong` frame inset 8px from the canvas edge + tag "Working · not yet accepted" top-left (`--draft-soft-bg` / `--draft-text`) |

**Layout.**

- **Header (44px)**: back/forward, title (13/600, one line, ellipsis) with the scope line (12px muted) inline after it, and
  ••• at the right.
- **Prompt strip (44px)**: the prompt on one line (click to expand to three), the `⌘ 1` pill, the pager and the Running
  pill. The prompt text starts at the canvas's left content edge (12px in), and so does the breadcrumb when it shows. Header
  plus strip is 88px, down from 176.
- The breadcrumb row is 40px (hidden here).
- The inspector is docked at 320px and **collapses to 0 when nothing is selected** **[PD]** (implement it by setting
  `--inspector` to 0, which keeps the grid pin). Environment then lives as a small chip in the prompt strip.
- The composer is docked.

**Accent rationing.** Periwinkle is every interactive signal and the selection ring. Running is neutral ink. Red `#F54731`
appears only for failure and in the logo deck, **at most one red element per screen**; deletions in the diff are muted, not
red. Approval is amber.

**Share viewer.**

- X4 (light): dot grid; the download card is `--surface` with a 1px `--border`, a 36px logo, "Relayer for Mac" at 14/600,
  the pitch at 13px muted, and a periwinkle Download button with a dark label (4.61), 36px tall.
- X5 (dark): the graph on the charcoal canvas.
- OG image: charcoal `#332E34` ground, periwinkle orbit rings, one red dot, and the cream logo tile.

**Test pins this prototype breaks** (beyond the four-way list in §2.3): `public-share-viewer.test.mjs:323` (branch) if the
share header radius is 10 or 14 instead of 12. It keeps `.interaction-banner` (`workspace-breadcrumb.test.mjs:191`) and the
workspace grid (`:192`).

**Betting on.** Continuity, speed and state legibility in a dark, compact workspace. It has the smallest migration, no font
payload and the least brand risk.

**Main risk.**

- **Types are whispered.** Hue on a 20px icon stroke is weak, since colour discrimination falls with mark size (Stone et
  al. 2014). The stricter ΔE floor (12) and stroke 2 only partly compensate.
- Charcoal under dark chrome may read "dim" rather than "dark".
- It may read as "another dark dev tool", with an undersold light mode.
- Labels on the right need horizontal room, and authored layouts may crowd.

---

### 6.2 Prototype B — **Surly · "Sticker"** (light-first, comfortable, playful)

**Hypothesis.** A warm, paper-first workspace with pill "sticker" nodes and one pink ink makes Relayer approachable and
share-worthy. Showing lime *only when GraphComplete accepts a turn* makes the product's core promise (explicit acceptance)
something people feel.

**Tokens (Palette B).**

| Role | Light | Dark | Notes |
|---|---|---|---|
| `--bg` | `#FDFAEA` (exact marshmallow) | `#100F0D` | warm neutrals (h98) |
| `--sidebar` | `#FDFAEA` | `#161612` | |
| `--surface` | `#FDFDF9` | `#161612` | floating cards |
| `--field` | `#F2F1EB` | `#1F1E1A` | |
| `--overlay` | `#FDFDF9` | `#272620` | |
| `--hover` / `--selected` | `#EBE9E2` / `#E4E2DA` | `#272620` / `#2E2D27` | |
| `--border` / `--border-strong` † | `#DBDAD2` / `#888680` (3.22) | `#383731` / `#76746D` (3.24) | |
| `--text` / `--text-muted` / `--text-faint` | `#1B1B17` / `#66655F` / `#8C8B84` | `#EFEEE9` / `#BAB9B2` / `#706F68` | |
| `--accent-solid` (+label) | `#E65979` (+`#1B1B17`, 4.99) | `#E65979` (+`#100F0D`, 5.54) | exact reel rose; large fills, running badge |
| `--accent-solid-alt` (+label) | `#CE4365` (+white, 4.55, Lc 76) | same | Send, Download, primary buttons |
| `--accent-soft-bg` / `--accent-text` | `#FFE8EB` / `#B13856` | `#38121A` / `#FF9DAD` | selected rows and their bar |
| `--selection-ring` | `#E65979` (3.30 on paper) | `#E65979` (5.54) | |
| `--running` † | `#E65979` (arc 3.30 on paper, 3.39 on pill fill) | `#E65979` | the palette's blue info (`#2A8EE7`) is **not used** |
| `--accepted-fill` (+label) † | `#C1E357` (+`#1B1B17`, 11.84) | `#C1E357` (+`#100F0D`, 13.13) | exact reel lime, **a fill only** |
| `--accepted-mark` | `#7A9500` (3.27 on paper, 3.36 on surface; never on `--field`) | `#C1E357` | lime as a *line* on paper is 1.39:1 |
| `--canvas-bg` | `#FDFAEA` | `#100F0D` | |
| `--canvas-grid` † | none | none | flat poster paper |
| `--edge` / `--edge-strong` † | `#8D8C86` (3.22) / `#66655F` | `#66645E` (3.24) / `#B4B3AC` | |
| `--node-fill` / `--node-stroke` † | `#FDFDF9` / `#8D8C86` (3.22) | `#1F1E1A` / `#706F68` (3.80) | |
| `--draft-outline` | `--node-stroke` | `--node-stroke` | dashed |
| `--danger-solid` / strong / text / soft | `#B23B19` / `#B23B19` / `#BC4524` / `#FFEBE6` | `#FE8160` / `#C8502F` / `#FFA289` / `#3A1C13` | orange-red (h36), away from the rose |
| `--warning-solid` / text / soft | `#C17A00` / `#996000` / `#FFEDD9` | `#D18500` / `#FEA92F` / `#352006` | approval |
| `--success-text` | `#4E6000` | `#ADCE3E` | used for diff additions |
| `--draft-solid` / text / soft | `#726F5F` / `#706D5D` / `#F1F0EB` | `#726F5F` / `#C2BEAC` / `#262521` | |
| `--diff-add` / `--diff-del` † | `#4E6000` (6.87) / `#BC4524` (5.13) | `#ADCE3E` / `#FFA289` | |
| `--stop-bg` / `--stop-glyph` † | `--field` / `--text` | `--field` / `--text` | |
| window first-paint background | `#FDFAEA` | `#100F0D` | |

**Family colours** (a solid 28px disc; icon colour as printed).

| Family | Hue | Light (icon) | Dark (icon) |
|---|---|---|---|
| F1 Document | 294 purple | `#5D2DAE` (white 8.56) | `#AB8EFF` (ink 6.62) |
| F2 Code | 231 blue | `#006D92` (white 5.83) | `#72D1FF` (ink 10.10) |
| F3 Data | 174 teal | `#00A486` (ink 5.47) | `#009D81` (ink 5.05) |
| F4 Systems | 96 mustard | `#826D00` (white 5.08) | `#CFAF00` (ink 8.05) |
| F5 People & agents | 330 magenta | `#D665CF` (ink 5.45) | `#B545AE` (white 4.74) |
| F6 Reasoning † | 273 indigo | `#596AE8` (white 4.51) | `#596AE8` (white 4.51) |
| Neutral | — | `--field` disc, `--text-muted` icon | same |

F6 changed from crimson `#9C0032` / `#FFA9AF`: its hue was 6° from the rose selection ring, and its dark value was ΔE 4.7
from `--danger-text`. Smallest pairwise ΔE: light 15.5, dark 15.7; CVD 7.7 / 9.5.

**Fonts.**

- **Bricolage Grotesque** (display): wordmark, share title (28–32px), empty-state and settings headings; weight 600–700,
  optical size on.
- **Figtree** (UI, 14px).
- **DM Mono** (code).
- All OFL on Google Fonts.

**Size scale.** 12/13/14/16/20/28 px. Base 14/1.5. Sidebar **248** †, rows 36, radius 10/16/24/999.

**Node spec (Sticker).**

- **Body**: a pill 36px tall with a 999 radius and max width 248px. Fill `--node-fill`, 1.5px `--node-stroke`.
- **Disc**: 28px, inset 4px on the left, in the family colour, with an 18px icon.
- **Title**: 14px/600, **one line** with an ellipsis; the full title shows in the tooltip and inspector.
- **Detail tier**: the pill becomes a 16px-radius, 2-line card up to 280×72, with a caption line.
- **Overview tier**: the disc only.
- **Opens a layer**: a second pill outline peeks 3px below; `›2` sits inside the pill's right end.
- **Badges**: 16px discs on the pill's **exterior** corners, in the fixed slots.

**Edge spec.** Gentle circular arcs with curvature 0.12 × edge length (Lombardi-style; it tested as accurate as straight
and is preferred aesthetically). 1.5px `--edge`, round caps, clipped at the pill box + 4px. Draft edges are dashed. When a
node is selected, its incident edges go to `--edge-strong` 2px.

**State encodings.**

| State | Treatment |
|---|---|
| Draft | dashed pill outline + hollow (paper) body; the disc keeps its colour; "Draft" caption |
| Child running | rose running badge at the exterior bottom-right (ink glyph); rose arc orbiting the disc, 1.4s; "Running" caption; reduced motion: badge only |
| Default (solid) | solid pill |
| Accepted | **quiet on nodes; loud at turn/layer level**: the status pill becomes a **lime fill + ink `check` "Accepted"** (28px); the canvas shows a static lime "Accepted ✓" stamp top-left (rotated −4°, poster-sticker; may fade in once ≤ 200 ms); accepted rows in the turn popover get a lime chip. Lime appears nowhere else |
| Child stopped | disc keeps its colour; ■ badge; "Stopped" caption |
| Child failed | 2px `--danger-solid` outline + `octagon-x` badge; "Failed" caption |
| Selected | 2px rose ring at a 2px gap; the pill lifts with a `0 4px 12px` shadow in light; fill unchanged |
| Focus | 2px `--text` ring outside |
| Working layer | dashed frame + tag "Working · not yet accepted" (`--draft-soft-bg`) top-left inside the canvas |

**Layout.**

- **Header (44px)**: back/forward, title (Bricolage 16/600) and scope line, •••.
- **Prompt card**: a **floating card**, radius 20, 64px, 8px below the header over the canvas top. Its prompt text's left
  edge is the breadcrumb's left edge (the breadcrumb, when shown, sits directly below the card).
- **Inspector** **[PD]**: a **floating card**, 340 wide, radius 24, 12px inset from the window edges, with a **fixed height**
  from the top inset to 12px above the composer, so the one-third annotation dock still works. Soft shadow
  `0 12px 40px rgba(27,27,23,.12)` in light; in dark, a lighter surface plus a 1px `--border`. It overlays the canvas
  instead of reflowing it; Fit and auto-pan use only the uncovered region (828px wide).
- **Composer**: a floating pill bar at the bottom centre of the uncovered canvas, max 760px, radius 24, 56px.
- **Sidebar**: flat paper, 248 wide, 36px rows, the selected row in `--accent-soft-bg` with the leading bar.

**Accent rationing.** Rose does all the talking: primary, selection, running and links. **Lime appears only when
GraphComplete accepts.** That is the "tiger on lime" moment; lime is never decoration and never on individual nodes.

**Share viewer.**

- X4 (light): paper; the share title in Bricolage 32/700; the download card is a cream `#FAF2E6` sticker (radius 20) with a
  40px logo and a rose (`#CE4365`, white label) Download button; the accepted layer carries the lime stamp.
- X5 (dark).
- OG image: marshmallow ground, pill stickers, a lime "Accepted" stamp and the logo.

**Test pins this prototype breaks**: `.interaction-banner{grid-column:1;grid-row:2;margin:8px 0 12px 12px;`
(`workspace-breadcrumb.test.mjs:191`, floating card) and `.thread-workspace{…grid-template-columns:minmax(0,1fr)
var(--inspector)…` (`:192`, floating inspector); `public-share-viewer.test.mjs:323` (branch; header radius 16).

**Betting on.** Warmth, charm and brand recall for shared links. Acceptance becomes a *felt* moment, which honours "a
model turn ending is not completion".

**Main risk.**

- Pills read as **buttons or tags**, and single-line titles truncate ("Constrained recovery revision" is about 215px at 14px).
- Rose running and rose selection share one hue; the badge and caption must carry the difference in a still frame.
- Cream may look beige or unserious to technical users.
- Floating panels cover the canvas (Figma reverted floating panels in UI3).
- Light-mode lime vs amber collapses under CVD simulation (ΔE 0.7), so glyphs are mandatory.
- Arcs add routing work.

---

### 6.3 Prototype C — **Apex · "Index"** (System-default parity, standard density, legibility-first)

**Hypothesis.** A crisp product system gives the clearest type-and-state reading in both themes. Cobalt drives every
interactive element, index-card nodes carry a colour tab, and a yellow **highlighter marks only what is not yet accepted**,
so "draft / working" is unmistakable.

**Tokens (Palette C).**

| Role | Light | Dark | Notes |
|---|---|---|---|
| `--bg` | `#F2FAFD` | `#0C1011` | cool slate neutrals (h217) |
| `--sidebar` | `#F2FAFD` | `#111718` | |
| `--surface` | `#F9FEFF` | `#111718` | |
| `--field` | `#E8F3F6` | `#182022` | |
| `--overlay` | `#F9FEFF` | `#1E272A` | |
| `--hover` / `--selected` | `#DFECEF` / `#D7E5E9` | `#1E272A` / `#242F32` | |
| `--border` / `--border-strong` † | `#CEDCE0` / `#7C888C` (3.23) | `#2E393C` / `#697578` (3.20) | |
| `--text` / `--text-muted` / `--text-faint` | `#161C1E` / `#5C676A` / `#808D91` | `#E7EFF2` / `#B0BBBE` / `#657175` | |
| `--accent-solid` (+label) | `#0C6FDC` (+white, 4.86, Lc 78) | same | **exact reel cobalt in both themes** |
| `--accent-solid-hover` | `#0062C7` | `#0062C7` | |
| `--accent-soft-bg` / `--accent-text` | `#E4F0FF` / `#1163C4` | `#09203F` / `#8ABCFF` | |
| `--selection-ring` † | **`#0059B7`** (3.24 on powder) | **`#8ABCFF`** (9.76) | exact cobalt is only 2.33 on powder; dark cobalt is 3.94 but Lc 28 |
| `--running` | `#0C6FDC` (arc on card fill 4.78) | `#0C6FDC` (3.41 on card fill) | |
| `--highlight-fill` (+label) | `#FEFD15` (+`#161C1E`, 15.81) | `#FEFD15` (+`#0C1011`, 17.56) | exact reel yellow, **a fill only**: draft title highlighter, Working tag chip, search hits |
| `--draft-outline` † | `#3D484B` (4.53 on powder) | `#AAB5B8` (9.12) | neutral dashed line; yellow as a line is invisible on light (1.00:1) |
| `--canvas-bg` † | **`#9AB9C2`** (exact powder, poster canvas) | `#0C1011` | chrome stays `#F2FAFD`; only the graph is "printed" |
| `--canvas-grid` † | `#88A6AF` (1.24) | `#1E272A` (1.26) | 24px dots |
| `--edge` / `--edge-strong` † | `#535E62` (3.21 on powder) / `#3D484B` (4.53) | `#596669` (3.21) / `#AAB5B8` | |
| `--node-fill` / `--node-stroke` † | `#F9FEFF` (2.05 on powder) / `#535E62` (3.21) | `#182022` / `#657175` (3.80) | the stroke carries the boundary |
| `--canvas-label` / `--canvas-label-muted` † | `#161C1E` (8.28) / `#3D484B` (4.53) | `--text` / `--text-muted` | tags and captions on the canvas |
| `--danger-solid` / strong / text / soft | `#B33736` / `#B33736` / `#BE423F` / `#FFEBE9` | `#E3645E` / `#C94C48` / `#FFA098` / `#3A1B19` | |
| failed outline on powder † | `#AA2E2F` (3.21) | `--danger-solid` | |
| `--warning-solid` / text / soft | `#C67600` / `#9F5E00` / `#FFEDDC` | `#FFA747` / `#FFA747` / `#362007` | orange, away from the yellow |
| `--success-solid` / text / soft | `#00884C` / `#007F47` / `#D8FAE2` | `#20B46B` / `#56DB8F` / `#0E2C1A` | Accepted pill (quiet) |
| `--diff-add` / `--diff-del` † | `#007F47` (5.00) / `#BE423F` (5.11) | `#56DB8F` / `#FFA098` | |
| `--stop-bg` / `--stop-glyph` † | `--field` / `--text` | `--field` / `--text` | |
| window first-paint background | `#F2FAFD` | `#0C1011` | |

**Family colours.** A 4px solid **tab** in the family colour runs down the card's left edge, on the card fill. The 28px icon
**tile** is a 14% tint (decorative) with a `--text` icon.

| Family | Hue | Light (vs card fill) | Dark (vs card fill) |
|---|---|---|---|
| F1 Document | 294 violet | `#9B75F9` (3.27) | `#845BDD` (3.56) |
| F2 Code | 213 cyan | `#009DB4` (3.19) | `#3AE1FF` (10.56) |
| F3 Data | 117 olive | `#4F5900` (7.48) | `#C3D916` (10.45) |
| F4 Systems † | 315 orchid | `#8A34AB` (6.53) | `#CA74EE` (5.71) |
| F5 People & agents | 351 rose | `#95005F` (8.45) | `#CE428E` (3.78) |
| F6 Reasoning † | 96 ochre | `#897300` (4.57) | `#C0A300` (6.68) |
| Neutral | — | no tab; `--field` tile | same |

F4 changed from blue `#005C95` (ΔE 5.7 from the powder selection ring, 10° of hue away). F6 changed from coral `#F0574E` /
`#FF8B7F` (2° of hue from danger; dark ΔE 4.8 from `--danger-text`). Smallest pairwise ΔE: light 12.7 (F3/F6), dark 13.9
(F1/F4); CVD 10.0 / 10.1.

**Fonts.** **Atkinson Hyperlegible Next** (UI, 13px; distinct letterforms built for legibility, from the Braille Institute)
and **Atkinson Hyperlegible Mono**. Both OFL, on Google Fonts. This is the legibility-first stance.

**Size scale.** 11/12/13/15/18/22/28 px. Base 13/1.45. Sidebar 248, rows 32, inspector 360, radius 6/8/12.

**Node spec (Index card).**

- **Body**: a 208×56 card, radius 10, `--node-fill`, 1.5px `--node-stroke`.
- **Tab**: 4px, full height, in the family colour.
- **Tile**: 28px, radius 6, 12px from the left.
- **Title**: 13px/600, 2 lines, max 148px wide.
- **Detail tier**: grows to 248×96 with an 11px uppercase family line ("DATA"), a one-line 12px excerpt and an action count.
- **Overview tier**: a 28px **white chip** (`--node-fill`, 1.5px `--node-stroke`) with its tab inside, so the tab never
  sits on the powder canvas.
- **Opens a layer**: a stacked card outline offset 3px, plus `›2` bottom-right.
- **Badges**: fixed slots. **Hit target**: the whole card.

**Edge spec.** Straight, 1.5px, non-scaling, `--edge`, clipped at the card box + 4px. Draft edges are dashed. When a node is
selected, its incident edges go to 2px `--edge-strong`, and the others dim to 40%.

**State encodings.**

| State | Treatment |
|---|---|
| Draft | the card **keeps its fill** (a hollow body would put the tab on powder at 1.56–1.63:1); 1.5px dashed `--draft-outline`; a **yellow highlighter behind the title** (`#FEFD15`, ink text 15.81); "Draft" caption |
| Child running | cobalt running badge bottom-right (white glyph 4.86); a cobalt 90° arc orbiting the icon tile, 1.4s; "Running" line; reduced motion: badge only. No bottom progress sweep |
| Default (solid) | solid card |
| Accepted | turn pill `check` "Accepted" in `--success-text` (quiet) |
| Child stopped | tab and tile keep their colour; ■ badge bottom-right; "Stopped" line |
| Child failed | 2px outline `#AA2E2F` (light) / `--danger-solid` (dark) + `octagon-x` badge; "Failed" line |
| Selected | 2px `--selection-ring` at a 2px gap; card fill unchanged |
| Focus | 2px `--text` ring outside |
| Working layer | the tag "Working · not yet accepted" as a **yellow highlighter chip** (`#FEFD15`, ink text) top-left inside the canvas, plus a dashed 1.5px `--edge-strong` frame |
| Stopped / failed retained layer | tag "Stopped · last working state" or "Failed · last working state" in `--field` / `--text` + a solid neutral frame |

**Layout.**

- **Header (48px)**: back/forward, title and scope (two lines on the left), ••• on the right.
- **Prompt card (72px, docked)**: the prompt (2 lines) starting at the canvas's left content edge, the `⌘ 1` pill, and the
  pager and pill on the right. The breadcrumb, when shown, starts at the same x.
- The breadcrumb is 40px (hidden here).
- The **inspector is persistent** at 360px **[PD]**. When nothing is selected it shows "This turn": prompt, model, state,
  node count and Environment. It is **never empty**. (PRD `:2305` keeps turn context "in their existing controls", so this
  summary needs a decision.)
- The composer is docked. Dividers are hairlines with no shadows.

**Accent rationing.** Cobalt is everything interactive and live. **Yellow marks only work that is not yet accepted** (the
draft title, the working-layer tag, "Draft" chips) plus search hits. Accepted is quiet. There is no decorative colour.

**Share viewer.**

- X4 (light): the **powder "print" canvas** with white cards; the download card is white with a cobalt Download button
  (white label, 4.86). A stranger instantly sees "a document of cards".
- X5 (dark).
- OG image: powder ground, three white cards with colour tabs, and a yellow highlighter on "Relayer".

**Test pins this prototype breaks**: none beyond §2.3 (docked banner and grid are kept; the share header can keep its 12px
radius).

**Betting on.** Clarity and product credibility. It has the strongest light/dark parity (cobalt is exact in both themes),
and the provisional state can't be missed.

**Main risk.**

- A generic "SaaS blue" look loses the poster character.
- Cards take the most canvas area, so 8-node layers get tight.
- The powder canvas may feel cold or heavy; labels on it reach WCAG 8.28 but only APCA Lc 61.
- Cobalt running and cobalt selection share one hue in light.
- Success green vs danger red collapses under CVD (ΔE 2.5–3.5), so glyphs are required.
- Atkinson runs wide, so labels take more room.

---

### 6.4 Prototype D — **Small Things · "Stamp"** (dark-first editorial, colour lives in content)

**Hypothesis.** The *answer* becomes the poster, which is the most distinctive result for shared links, if three things
happen together: the chrome goes monochrome and editorial (an olive block sidebar in both themes, a serif prompt headline,
ink or ice buttons); all colour moves into the graph as flat screen-print stamps; and red is kept for failure. Dark is the
default because D's two reel inks (ice and red) only read exactly on a dark ground (08 §6), and it separates D from B.

**Tokens (Palette D).**

| Role | Light | Dark (default) | Notes |
|---|---|---|---|
| `--bg` | `#F9F9F2` | `#10100C` | olive-tinted neutrals (h107) |
| `--sidebar` † | **`#B9B864`** (exact reel olive) | **`#2B2A0E`** (deep olive; 1.31 vs page) | the olive block in both themes |
| `--sidebar-text` † | `#1B1B16` (8.32) | `#EEEEE7` (12.51, Lc 93) | all sidebar text; also the sidebar focus ring |
| `--sidebar-muted` † | `#373731` (5.76; 4.63 on hover) | `#BABAB1` (7.46; 6.43 on hover) | section labels |
| `--sidebar-hover` † | `#A6A551` (ink 6.69) | `#353514` | |
| `--sidebar-selected` † | **`#D5E3FB`** exact ice (ink 13.34) + 3px ink bar | `#403F1F` (text 9.25) + 3px ice `#D5E3FB` bar (8.32) | |
| sidebar state marks † | glyph in `--sidebar-text` inside a 16px `--surface` disc (16.94) | same (15.57) | never status colours on olive (they measure 1.64–2.51) |
| `--surface` | `#FDFDF8` | `#161611` | |
| `--field` | `#F1F2E8` | `#1F1F18` | |
| `--overlay` | `#FDFDF8` | `#26261E` | |
| `--hover` / `--selected` | `#EAEADF` / `#E3E3D7` | `#26261E` / `#2D2E24` | |
| `--border` / `--border-strong` † | `#DADACF` / `#88877D` (3.20) | `#37382E` / `#74746A` (3.23) | |
| `--text` / `--text-muted` / `--text-faint` | `#1B1B16` / `#65655D` / `#8B8C81` | `#EEEEE7` / `#BABAB1` / `#6F7065` | |
| `--primary` (+label) † | **ink `#1B1B16`** (+`#F9F9F2`, 16.35) | **exact ice `#D5E3FB`** (+`#10100C`, 14.72) | Send and primary buttons; the derived light blue `#6790DA` is **not used** |
| `--accent-soft-bg` / `--accent-text` | `#D5E3FB` / `#4164A3` | `#152034` / `#D3E3FF` | links |
| `--selection-ring` | `#496CAC` (4.94) | `#D5E3FB` (14.72) | |
| `--running` † | `--text` | `--text` | neutral ink (gene Q) |
| `--canvas-bg` | `#F9F9F2` | `#10100C` | flat paper |
| `--canvas-marks` † | registration crosses 7px, every 96px, `#DADACF` (1.33) | `#2D2E24` (1.39) | sparse, so slightly stronger than dots |
| `--edge` / `--edge-strong` † | `#8B8C82` (3.22) / `#65655D` (5.56) | `#65655B` (3.24) / `#B3B3AA` | |
| `--node-fill` / `--node-stroke` † | `#FDFDF8` / `#8B8C82` | `#1F1F18` / `#6F7065` (3.80) | neutral family and colourless (failed) tiles only |
| `--danger-solid` / strong / text / soft | `#F44731` / `#E0311C` / `#D5220C` / `#FFEBE7` | `#F44731` / `#E0311C` / `#FFA190` / `#3A1B16` | **red = failure only** (+ logo deck) |
| `--warning-solid` / text / soft | `#AF8433` / `#8F6504` / `#FCEED8` | `#DCAF61` / `#E3B667` / `#2F230E` | approval |
| `--success-solid` / text / soft | `#529A63` / `#347C48` / `#E1F7E5` | `#82CB92` / `#89D298` / `#172B1B` | Accepted pill (quiet) |
| `--draft-solid` / text / soft | `#70705F` / `#6E6F5E` / `#F0F1EB` | `#8D8E7C` / `#BFBFAD` / `#252621` | |
| `--diff-add` / `--diff-del` † | `#347C48` (4.99) / `--text-muted` + "−" | `#89D298` / `--text-muted` + "−" | no red for deletions |
| `--stop-bg` / `--stop-glyph` † | `--field` / `--text` | `--field` / `--text` | Send may be ink/ice; **Stop is never ink** |
| window first-paint background | `#F9F9F2` | `#10100C` | |

**Family colours.** The **whole 48px tile** is filled with the family colour; icon colour as printed. Every tile is ≥ 3:1
against the canvas.

| Family | Hue | Light (icon; vs canvas) | Dark (icon; vs canvas) |
|---|---|---|---|
| F1 Document | 300 violet | `#A670F3` (ink 5.13; 3.19) | `#8E57D8` (white 4.66; 4.09) |
| F2 Code † | 216 cyan | `#009DB8` (ink 5.36; 3.05) | `#008FA9` (ink 4.53; 5.00) |
| F3 Data | 111 olive-lime (ground anchor) | `#787A00` (white 4.58; 4.33) | `#D1D400` (ink 10.80; 11.92) |
| F4 Systems | 327 plum | `#841387` (white 8.66; 8.19) | `#FFA5FF` (ink 9.93; 10.97) |
| F5 People & agents | 357 pink | `#EE5B9A` (ink 5.43; 3.01) | `#CB397C` (white 4.76; 4.01) |
| F6 Reasoning † | 171 teal | `#007B61` (white 5.24; 4.96) | `#00B28D` (ink 6.38; 7.04) |
| Neutral | — | `--field` tile + 1.5px `--node-stroke` + `--text-muted` icon | same |

F2 changed from blue `#006ABE` (ΔE 5.3 from the `#496CAC` selection ring; 10° of hue). F6 changed from brick `#981C00` /
`#FF8C74` (2° of hue from failure red, which contradicts D's "red = failure only"; dark ΔE 4.9 from `--danger-text`).
Smallest pairwise ΔE: light 12.1 (F3/F6), dark 12.5 (F2/F6); CVD 8.3 / 7.8. Tiles are large, so this is enough.

**Fonts.**

- **Fraunces** (display serif, variable opsz/weight): the prompt headline (22/600), share title (40/600), Node Details
  title (20/600), wordmark.
- **Instrument Sans** (UI, 14px).
- **JetBrains Mono** (code).
- All OFL, on Google Fonts. The serif echoes the poster's red serif type; the UI stays sans for density.

**Size scale.** 12/13/14/16/20/28/40 px. Base 14/1.55. Sidebar 248, rows 34, inspector 368 (reading, body **15/1.55**;
authored content width 328 after 20px padding), radius 2/6/10.

**Node spec (Stamp).**

- **Tile**: 48×48, radius 10, solid family colour, 22px icon. No outline, except the neutral family and state outlines.
- **Label**: **below**, centred, 13px/600 `--text`, max 168px, 2 lines. It has a 3px `--canvas-bg` halo, and edges are
  clipped at the union of the tile box, the label box and 4px, which fixes today's edge-through-label defect.
- **Detail tier**: an 11px uppercase family name above the label and a one-line excerpt below.
- **Overview tier**: a 28px tile with no label.
- **Opens a layer**: a second tile edge peeks 3px down-right in `--border-strong`, like a stack of prints.

**Edge spec.** Straight **2px** "print line" in `--edge`, round caps. Draft edges are dashed 5/4. When a node is selected,
its incident edges go to 2.5px `--edge-strong`, and non-neighbours dim to 35%.

**State encodings.**

| State | Treatment |
|---|---|
| Draft | the tile becomes **hollow**: a 2px dashed outline in the family colour, canvas-coloured inside, icon in the family colour (≥ 3.01 on canvas); "DRAFT" 11px uppercase under the label |
| Child running | running badge (`--field` disc, `--text` glyph); a `--text` 90° arc orbiting 4px outside the tile, 1.4s; "Running"; reduced motion: badge only |
| Default (solid) | solid tile |
| Accepted | turn pill `check` "Accepted" (quiet) |
| Child stopped | tile keeps its colour; ■ badge; "Stopped" |
| Child failed | the tile loses its colour (→ `--field` fill, 1.5px `--node-stroke`, `--text-muted` icon) + 2px `--danger-solid` outline + `octagon-x` badge; "Failed"; **the only red on the canvas** |
| Selected | 2px ring (`#496CAC` light / `#D5E3FB` dark) at a 2px gap; label weight stays 600 |
| Focus | 2px `--text` ring outside |
| Working layer | the headline band shows "WORKING · NOT YET ACCEPTED" (11px uppercase) next to the pager, the canvas carries the same tag top-left, and a dashed hairline frame |

**Layout.**

- **Sidebar**: the olive block in both themes (exact olive in light, deep olive in dark); ink or light text; ice
  selected row with its bar; the cream logo tile sits on the block (13.13 in dark).
- **Title row (36px)**: back/forward, title (Instrument Sans 13/600), scope (12px muted), •••.
- **Headline band (88px)** below it: the prompt in **Fraunces 22/600**, two-line clamp, starting at the canvas's left
  content edge; the `⌘ 1` pill; the pager and status pill on the right. No eyebrow.
- The breadcrumb sits below the band, sharing the prompt's left edge (hidden here).
- The inspector is docked at 368 and styled like a reading column, with 1px rules between sections instead of cards.
- The composer is docked. Send is ink (light) or ice (dark); **Stop is `--field` with a `--text` square**.
- Flat, with no shadows; 1px rules.

**Accent rationing.** **The chrome has no accent.**

- Primary is ink (light) or ice (dark).
- Blue appears only as the selection ring.
- Running is neutral ink.
- The **six family colours on the canvas** are the only saturated colour, and red is only for failure.
- Olive and ice are *ground* colours, never signals.

**Share viewer.**

- X4 (light): the share title in **Fraunces 40/600** above the canvas, set like a poster headline, with the meta line in
  11px uppercase; the download card is ink-on-cream (`#FAF2E6`) with an ink Download button.
- X5 (dark): near-black olive with ice ink.
- OG image: olive ground, three colour stamps, the serif "Relayer" in **ink `#1B1B16`** (8.32 on olive), and the logo.
  Red-orange appears only as a small mark (red type on olive measures 1.74:1).

**Test pins this prototype breaks**: `.interaction-banner{grid-column:1;grid-row:2;margin:8px 0 12px 12px;`
(`workspace-breadcrumb.test.mjs:191`, the band) and `public-share-viewer.test.mjs:323` (branch; header radius 10).

**Betting on.** Distinctiveness. Shared links look like designed posters, the typography is recognisable, and the answer
is the hero.

**Main risk.**

- The olive sidebar is polarising (it may read "dirty"). On the light olive block, ink text passes WCAG (8.32) but reaches
  only APCA Lc 61.
- A serif in a dev tool.
- Labels below tiles need careful edge clipping.
- Three font families and a new chrome make it the highest implementation cost.
- At 1280px wide, the canvas drops to 640px (50%) with the inspector open, the tightest of the four.

---

## 7. Evaluation rubric (what Vishal comments against)

Score each prototype 1–5 on each dimension. **Only the artboards named in the "Look at" column count**, which keeps
comments comparable.

| Dimension | The question | Look at | 1 = | 3 = | 5 = |
|---|---|---|---|---|---|
| **Legibility** | Can I read every label, caption and control at 100% without leaning in? | X2, X3, X5 | squinting; tiny or faint text | fine, with a few small spots | effortless everywhere, including the phone sheet |
| **Type & state clarity** | Within 5 seconds and without the legend: Which two nodes share a family? Which node is draft? running? stopped? failed? selected? Is this layer accepted or still working? (**7 answers**) | X2, X3 | ≤ 2 correct | 4–5 correct | 7 correct |
| **Brand character** | Does it feel like *Relayer* (the skateboarder, the poster palette), and would I screenshot it? | all | generic tool | pleasant but anonymous | unmistakable, and I want to show it |
| **Light/dark parity** | Does the same scene read the same in both themes? Does anything disappear or change meaning? Do both feel designed? | X2 vs X3 | one theme is an afterthought | minor drift | equal craft, identical meaning |
| **Density** | Right for all-day use: enough canvas, not cramped, calm? | X2, X3 | cramped or wasteful | acceptable | exactly right for daily work |
| **Share-viewer presence** | A stranger opening the link: do they know within 5 seconds what this is (a read-only snapshot, whose, what), and does it make them want Relayer? Does it work on a phone? | X4, X5, the share landing on X6, OG on X1 | confusing or bland | clear | clear, branded and delightful on both |

The expected answers for the state question are in §3.4 (N1 and N2 share Document; N4 draft; N3 running; N5 stopped; N6
failed; N1 selected; working, not accepted).

**Comment format** (one line each, so the next generation can parse it):

```
[C3] state 3/5 — yellow draft highlight reads as a search hit. KEEP: index cards. CHANGE: draft needs the dashed frame to dominate.
[B4] brand 5/5 — lime Accepted stamp is the best moment in the set. CROSS: lime acceptance → A.
[A2] density 4/5 — right amount of canvas. KILL: labels-right when titles are long.
[B2] state 4/5 — running reads as selected. CHANGE: Q gene → neutral ink.
```

**How generation 2 is built from the comments** (branch width stays 4):

1. **Refine** the highest-scoring prototype, applying its CHANGE comments.
2. **Refine** the second highest.
3. **Cross over**: combine the two top prototypes on the genes (§6.0) that received KEEP or CROSS comments, respecting the
   gene dependencies and re-running the family-colour check.
4. **Mutate**: take the most-criticised gene across the set and explore one fresh value for it (for example a new node
   shape, if all four shapes drew complaints).

Invariants (§2) and the shared state grammar (§3.2, apart from gene Q, the running ink) never mutate. Any gene with a KILL
comment is removed from the pool.

---

## 8. Decisions, corrections and verification

### 8.1 Product decisions this brief surfaces (drawn as proposals; need Vishal's call and a PRD update)

1. **Default appearance.** Add **System** to the desktop (`dark | light | system`). Should the default be System (C's
   stance) or Dark (A and D)? Today there is no System option (`register-ipc.mjs:103`), while the share viewer already
   follows the OS.
2. **Icon → family colour mapping** (§3.3). It is presentation-only and needs no contract change, but the PRD promises only
   "an icon and a title". The inspector keeps the raw `kind` caption, so no model-authored field is replaced.
3. **Drawing working (current) and draft layers and nodes on the canvas**, plus node-level running/stopped/failed marks for
   semantic child completions. The data exists (`currentLayerId`, `leasedActionId`), but today only accepted layers are
   drawn.
4. **Showing capability marks on nodes**: opens a layer (generic), invoke, input, attached.
5. **Accepted made visible** (pill + turn rows), and its copy: "Accepted", not the older evidence's "Complete".
6. **Fit cap at 1.25×, screen-constant node size and labels, and non-scaling edges.** This changes every first impression,
   including evidence screenshots and Eval judge pixels (the judges were calibrated on the current renderer), and it breaks
   three `test/graph-camera.test.mjs` pins (§2.3).
7. **Share viewer**:
   - the meta line ("Read-only snapshot · date · project");
   - hiding the dead back/forward arrows;
   - the compact family key (X4) and "Key" button (X5);
   - **two PRD drifts, recorded together**: main's PRD asks for "Also for Windows" (the branch removed it and its tests
     forbid it) and "a thin public bar" (satisfied by the existing `.thread-header` row, §2.3);
   - a phone download CTA that can't be acted on;
   - a PNG OG image with an absolute URL (a cross-repo change);
   - any 404 design (owned by the private service repo).
8. **A token contract for authored Node Details** (publishing `--relayer-*` variables): a graph-client contract change.
9. **Logo vector redraw**, which removes the baked-in frame. This is a brand decision.
10. **Adopt WCAG 2.2 AA, the 11px floor and the 3.2 stroke margin** as the written bar in the PRD.
11. **Sidebar state marks** (Running, Needs approval, Failed). The PRD calls the sidebar "a compact list" with no run
    dashboard (`:1229-1230`); today only the active row is marked.
12. **Inspector behaviour**: A's collapse-to-0 (reflows the canvas on every selection), B's floating card (covers the
    canvas), C's persistent "This turn" summary (PRD `:2305` keeps turn context in its existing controls), and the
    ≤ 1100px overlay sheet instead of stacking (PRD `:585`).
13. **Model identity in the prompt card.** It was removed and a test forbids it (`workspace-navigation-controls.test.mjs:124-125`);
    bringing it back is a decision, not a restyle.
14. **Live-view "pinned" indicator** ("Viewing an earlier layer · Jump to live") and its copy.

### 8.2 Corrections to the research inputs (builders: do not copy these)

1. `palettes.css` aliases `--stop-*` to **danger**, and 08 calls A/D red "danger/stop". That is **wrong**. The PRD
   (`:2175`) and `scripts/test-desktop-stop.mjs:51-62` require Stop and the stopped notice to be neutral. Red means
   **failed/danger only**.
2. 06 §9 suggests a remembered theme toggle in the share viewer via `localStorage`. The viewer boundary forbids storage
   (`main.js:5-14`), so it **follows the OS only**.
3. 07 §3(d) proposes a separate "link" badge for reference vs expand. That would expose navigate relations, which the PRD
   forbids (`:1829`, `:2255`). Use **one generic "opens a layer" mark**.
4. 07 §6.1 and 08 §7 give different family lists. **§3.3 is canonical**: verification and signal icons are neutral, and
   agents join People.
5. `--canvas-grid` in `palettes.json` is 1.48–1.61:1, which is louder than the 1.15–1.35:1 dot-grid rule. The adjusted
   values are in the token tables.
6. **Tinted fills with coloured icons fail**, and 08 §7's "put the type colour on the icon, or a 2 px ring or inner tint"
   needs the constraint that the mark sits on plain node fill, or is a solid fill with a white/ink icon. 08 §7's "show
   selection with `--focus-ring`" is split here: selection ring (accent) and focus ring (`--text`).
7. 03 §7 suggests 375×812 phone artboards and 1440×1000 web artboards. This brief chooses **390×844** (the layout must hold
   at 375×812) and 1440×900 (the same size as the desktop artboards).
8. C's dark focus ring `#0C6FDC` passes (3.94:1) but reads weakly (Lc 28), so C's dark selection ring is `#8ABCFF` (9.76:1).
9. 01 §9.2 proposes "edge style per relation, arrowheads". Edges are undirected (PRD `:2302`) and relations have no kinds
   in the model.
10. 05 §5.13 proposes arrowheads, tapered edges and animated "working" edges. Edges are undirected, and only running and
    stopping move.
11. 05 §5.6 and §6 propose "kind = silhouette". There is no fixed kind taxonomy (`kind` is model-authored free text), so the
    silhouette is one per prototype, uniform across nodes.
12. 05 §4 and 07 §4 say running must not reuse the selection hue; the gen-1 draft of this brief froze that merge into the
    invariants. It is now gene Q (A and D neutral ink; B and C accent), and a still-frame badge is mandatory.
13. 03 §7 lists the share dialog, error and 404 pages and a 56–64px share glyph. The dialog and an error card are on X6;
    the 404 is cross-repo **[PD]**; the node sizes follow §5, not the 56–64px glyph.
14. The gen-1 draft's canonical eyebrow "Your interaction · Codex · GPT-5.6-Terra" came from an old capture and is now
    test-forbidden. It is removed everywhere.
15. 02 §6's thread title "Inspect codex tool work" is not in the repo; it is replaced by "Send-to-display flow".
16. The gen-1 draft's "fit padding 64" had no basis; today's value is 48 (`workspace.js:157`), kept for desktop.
17. The gen-1 draft said a running node's child is "the harness's native recursion". Per `CONTEXT.md`, a native helper never
    becomes a child; only a **semantic child completion** (agent-authored code calling Complete) is drawn.
18. 08's categorical sets are superseded where they collide with the final reserved colours (all of A; B F6; C F4 and F6;
    D F2 and F6). See the §6 tables.

### 8.3 Checks I computed for this brief

All values are WCAG ratios (APCA absolute Lc in brackets where relevant), computed with the colour library used by 08
(`tmp/color.mjs`). New scripts for this final version:

- `tmp/final-brief-checks.mjs` → `final-brief-checks.out.txt`: stroke headroom fixes, running marks, the selection-fill
  failures, D sidebars, diff tokens.
- `tmp/final-brief-cat.mjs`: the family-colour search against the final reserved sets. A was searched globally; B, C and D
  repaired only failing slots. A and B come from the default run (`final-brief-cat.out.txt`, `final-brief-cat.base.json`).
  C and D come from the run with wider status gaps, `GAPS='{"C":{"warning":30},"D":{"danger":30}}'`
  (`final-brief-cat.cd30.out.txt`, `final-brief-cat.cd30.json`); the default run had put D's Code family on orange, 23°
  from failure red.
- `tmp/final-brief-hues.mjs`: which hues A's constraints leave available (used to reject a 15 ΔE floor for A).
- `tmp/final-brief-verify.mjs` → `final-brief-verify.out.txt`: every final family value and every new token in this brief.

Key results:

- **Strokes ≤ 2px** (all ≥ 3.20 after the fixes; before, 26 stroke tokens were below 3.2: 24 at 3.00–3.06, plus C's draft
  and failed marks on powder at 2.25 and 2.87):

  | Prototype | Light edge / node stroke / border-strong | Dark edge / node stroke / border-strong |
  |---|---|---|
  | A | 3.24 / 3.24 / 3.22 | 3.22 / 3.23 (charcoal) / 3.23 |
  | B | 3.22 / 3.22 / 3.22 | 3.24 / 3.80 / 3.24 |
  | C | 3.21 / 3.21 (powder) / 3.23 | 3.21 / 3.80 / 3.20 |
  | D | 3.22 / 3.22 / 3.20 | 3.24 / 3.80 / 3.23 |

- **Selection rings vs canvas**: A 3.54 / 3.53 (charcoal); B 3.30 / 5.54; C 3.24 (powder) / 9.76; D 4.94 / 14.72.
- **Focus = `--text`**: ≥ 11.79:1 on every standard surface, including selected rows (A-light 13.29) and B's rose-soft row
  (14.80). On D's olive sidebar the ring is `--sidebar-text`: 8.32 on olive and 6.69 on the olive hover row.
- **Why selection must not change the fill**: A-dark F1 on `--selected` 2.91; A-light Code on `--selected` 2.47; C-light F1
  tab 2.58; C-dark F1 tab 2.96.
- **Hover vs selected** fills: 1.07–1.11:1 in all eight themes (hence the leading bar); `--accent-text` on `--selected`
  ≥ 4.51 (the bar passes).
- **Placeholders**: `--text-faint` on `--field` 3.00–3.31; `--text-muted` on `--field` 5.16–8.50.
- **Running marks**: A/D ink arcs 11.40–16.36; B rose arc 3.30 (paper) / 3.39 (pill); C cobalt arc on card fill 4.78 / 3.41;
  B badge ink on rose 4.99; C badge white on cobalt 4.86.
- **Family sets** (smallest pairwise ΔE, normal / CVD): A 14.8 / 7.4 light, 14.4 / 7.8 dark; B 15.5 / 7.7, 15.7 / 9.5;
  C 12.7 / 10.0, 13.9 / 10.1; D 12.1 / 8.3, 12.5 / 7.8. Every family clears its grounds (≥ 3.01), its icon rule
  (≥ 4.51) and its reserved-colour distance (≥ 10; A ≥ 12).
- **A charcoal canvas**: text 11.40; muted 6.76; periwinkle ring 3.53; grid 1.26; node fill 1.26 (the stroke carries it).
- **C powder canvas**: labels 8.28 [Lc 61]; muted labels 4.53 [Lc 49]; draft outline 4.53; failed outline 3.21; ring 3.24;
  card fill 2.05 (the stroke carries it); yellow chip text 15.81.
- **D sidebars**: light ink 8.32 [61], muted `#373731` 5.76 / 4.63 on hover, ice selected row 13.34, surface-disc marks
  16.94; dark text 12.51 [93], muted 7.46 [61], selected-row text 9.25, ice bar 8.32, marks 15.57.
- **D OG**: ink on olive 8.32; red on olive 1.74 (rejected); red on cream 3.26.
- **Primary buttons**: A periwinkle + ink 4.61; B `#CE4365` + white 4.55; C cobalt + white 4.86; D ink 16.35; D ice 14.72.
- **Diff tokens** on `--surface` / `--field`: every add and del ≥ 4.50.
- **Brand**: cream tile on A-dark bg 17.22; deck `#D74326` on B paper 4.25, on cream 4.01.
- **Grid dots** (target 1.15–1.35): A 1.23 / 1.26 (charcoal); C 1.24 (powder) / 1.26; D crosses 1.33 / 1.39.
- **Phone budget** (X5): 47 + 48 + 56 + 76 + 24 + 377 + 216 = 844; graph 44.7%.
- **Known APCA misses** (WCAG passes): D light olive sidebar ink Lc 61; C powder labels Lc 61; D dark sidebar muted on hover
  Lc 59.

Every other ratio in this brief is from `palettes.json` (08) or the gen-1 checks (`tmp/brief-checks*.mjs`).

---

## Appendix A — Complete icon → family mapping (all 116 allowlist names, `icons.js:9-126`)

| Family | Icons |
|---|---|
| **F1 Document** (13) | archive, book-open, book-open-text, clipboard, copy, file, file-edit, file-output, file-search, file-text, library, pencil-line, scroll-text |
| **F2 Code** (18) | blocks, braces, code, component, file-code, file-code-2, folder-git-2, function-square, git-branch, git-branch-plus, git-commit, git-compare, git-graph, git-merge, git-pull-request, package, puzzle, terminal |
| **F3 Data** (23) | bar-chart-3, box, boxes, columns-3, database, database-backup, folder, folder-tree, folders, frame, grid-3x3, layers, layout, layout-grid, layout-panel-left, layout-template, list, list-ordered, list-tree, panels-top-left, pie-chart, square-dashed-kanban, table |
| **F4 Systems** (21) | cloud, cog, cpu, globe, hard-drive, key, lock, monitor, network, plug, radio, rss, satellite, server, server-cog, settings, shield, smartphone, webhook, wifi, wrench |
| **F5 People & agents** (8) | bot, mail, messages-square, mic, send, share-2, user, users |
| **F6 Reasoning** (10) | bolt, brain, compass, palette, route, search, sprout, star, workflow, zap |
| **Neutral** (23) | alert-circle, alert-triangle, arrow-right-circle, arrow-right-left, bell, check-circle, clipboard-check, credit-card, heart, help-circle, info, link, link-2, list-checks, loader, menu, message-circle-question, play-circle, rotate-ccw, shield-alert, shield-check, square, upload; also the `circle` fallback and all aliases resolve through their target |

The mapping was checked against the allowlist: all 116 names mapped once, no duplicates (`tmp/critique-icons.mjs`). Icons in
real fixtures map as follows: list, database, layout-template, panels-top-left and box → Data; users and messages-square →
People; git-branch and git-compare → Code; book-open and file → Document; search → Reasoning; arrow-right-circle, link,
shield-check and info → Neutral. So a typical graph shows 3–5 families plus neutral, and it stays calm.

## Appendix B — Sources

- Research reports in this folder:
  - `00-inputs.md`
  - `01-desktop-visual-system.md` (tokens, type, sizes, contrast Appendix C)
  - `02-object-types.md` (object and state inventory, content kit)
  - `03-share-viewer.md` (CSP, layout, phone, OG, share dialog strings)
  - `04-product-constraints.md` (PRD rules, Stop, fonts, brand)
  - `05-prior-art.md` (Linear, Primer, Radix, n8n, Dify, ComfyUI, tldraw…)
  - `06-color-science.md` (OKLCH ladders, APCA, CVD)
  - `07-graph-encoding.md` (channels, semantic zoom, shape languages)
  - `08-palette-engineering.md` + `palettes.json` / `palettes.css` (token values; categorical sets superseded as noted)
  - `10-design-brief.md` (gen-1 draft) and `11-brief-critique.md` (adversarial review)
- Repo (at `76bfe5fe`):
  - `CONTEXT.md`; `docs/architecture.md:145-154`
  - `desktop/renderer/styles.css`, `index.html`, `theme-bootstrap.js`
  - `src/navigation.js:62-100`, `src/model-picker.js:49-279`, `src/action-invocation-state.js:18-23`,
    `src/update-indicator-model.js:11-13`, `src/interaction-failure-model.js`
  - `src/product-workspace/{workspace.js,view.js,icons.js,graph-layout.js,node-detail-runtime.js}` (notably
    `workspace.js:77-78`, `:157`, `:283-326`, `:541-550`, `:1290-1302`, `:4298-4307`, `:4541`; `graph-layout.js:1-4`, `:58-84`)
  - `crates/relayer-graph-core/src/graph/writer.rs:345-390`
  - `docs/prd/index.html` (`:289`, `:585`, `:795`, `:1105-1111`, `:1133`, `:1228-1230`, `:1247-1248`, `:1345`, `:1829`,
    `:2124-2125`, `:2165`, `:2170-2177`, `:2199`, `:2211`, `:2255`, `:2258`, `:2302-2312`, `:2383`)
  - Tests: `test/workspace-navigation-controls.test.mjs:101-126`, `:203-210`; `test/workspace-breadcrumb.test.mjs:191-193`;
    `test/workspace-keyboard.test.mjs:595-596`; `test/graph-camera.test.mjs:86-148`;
    `test/tutorial-visual-contract.test.mjs:23-49`; `scripts/test-desktop-stop.mjs:51-62`;
    branch `test/public-share-viewer.test.mjs:309-332`
  - Content: `packages/eval-runner/src/cases/recursive-graph-memory.ts:10-37`; `test/support/lantern-2x2-fixture.mjs:13`,
    `:55-110`; `packages/eval-runner/src/fixtures/approval.ts:102-103`; `packages/harness-host/src/implementations/codex-basic.ts`;
    `docs/prd/assets/evidence/model-picker/manifest.json`; `docs/prd/assets/evidence/environment-rail/manifest.json`;
    `docs/evidence/issue-453-stopped-child-diagnostic/README.md`; `docs/evidence/issue-506-stop/*`
- Standards:
  - WCAG 2.2: https://www.w3.org/TR/WCAG22/ (1.4.1, 1.4.3, 1.4.11, 2.3.1, 2.4.13, 2.5.8)
  - Understanding 1.4.3: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
  - APCA: https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html
  - Apple HIG typography: https://developer.apple.com/design/human-interface-guidelines/typography
- Graph encoding:
  - Stone, Szafir & Setlur 2014: https://graphics.cs.wisc.edu/Papers/2014/SAS14/2014CIC_48_Stone_v3.pdf
  - Xu et al. 2012: https://ieeexplore.ieee.org/document/6327250/
  - Boukhelifa et al. 2012: https://hal.science/hal-00717441
- Fonts (OFL):
  - Atkinson Hyperlegible: https://www.brailleinstitute.org/freefont/
  - Bricolage Grotesque, Figtree, DM Mono, Fraunces, Instrument Sans, JetBrains Mono, Atkinson Hyperlegible Next and Mono:
    Google Fonts (verify `OFL.txt` before bundling)

## Appendix C — How each critique point was handled

"Accepted" means applied as the critique proposed. "Modified" means the problem was real but the fix differs; the reason is
given. "Rejected" means the point, or part of it, was wrong or unworkable; the one-line reason is given.

| Critique point | Disposition | What changed / why |
|---|---|---|
| C1 running reuses the selection hue, frozen | Accepted | Running ink is gene Q (A, D neutral ink; B, C accent); mandatory running badge + caption; reduced motion = badge only (§3.2, §6.0) |
| C2 A and D drop the thread title; C breaks the left edge; ••• missing | Accepted | Title, scope and ••• restored in all four; prompt and breadcrumb share one x; merges are visual only (§2.2, §6) |
| C3.1 breadcrumb carries the Working tag at root | Accepted | Breadcrumb hidden; the tag is inside the canvas, top-left |
| C3.2 "accepted" nodes inside a working layer | Modified | Substance accepted (no ✓ or success colour on a working canvas). **The name "committed" is rejected**: it already means a committed input answer and a history-navigation result in this codebase; the state is called "Default (solid)" instead |
| C3.3 record-stopped drawn; invented child Retry; failed layer mislabelled | Modified | Record-stopped is never rendered; "Failed · last working state" added. **N5 as "invoke stopped → Retry <label>" is rejected** for the running scene: mutating actions are disabled while a turn runs, and Retry appears only after an invocation ended unresolved. N5 is a stopped semantic child that keeps its family colour; the Retry state is an X6 specimen |
| C4 phone artboard cannot be drawn | Modified | Exact 844px budget given; peek is 216px (25.6%), not ~30%, so the graph gets 377px (44.7%); 16px phone fit padding; selected-only labels; 44px Download hit area |
| C5.1 forbidden eyebrow | Accepted | Removed everywhere; model identity in the banner is [PD] |
| C5.2 invented titles | Modified | Every real Lantern string is used and the rest are labelled illustrative. **Replacing N2–N6 with task-system titles is rejected**: mixing a queue/worker fixture into a Lantern launch memo makes the one scene Vishal reads incoherent |
| C5.3 no input action; use the node-detail fixture actions | Modified | Input "Review note" and card "Compare approaches" added (real); the two pills use the real Lantern labels "Supporting brief 1/2" instead of "Open implementation notes / referenced evidence", for coherence |
| C5.4 invented share title and project | Accepted | Share title = the real thread title; "relayer-site" replaced by the illustrative "h3" project holding the real h3 thread |
| H1 selection fills break family contrast; accent focus fails on rows | Accepted, extended | Selection is ring-only; focus is `--text` **everywhere** (not only on rows), which removes every accent-focus failure |
| H2 powder canvas defeats C's marks | Modified | Draft keeps the card fill; failed `#AA2E2F`; ring `#0059B7`; overview is a white chip. **Draft outline `#5F5F00` is rejected**: it sits ΔE 3.3 from C's olive family; the critique's alternative `#3D484B` is used. The running sweep is dropped (M5), so `#0059B7` for it is moot |
| H3 D failures (OG, sidebar, ink Stop) | Accepted | OG wordmark in ink; sidebar marks as ink glyphs on surface discs; selected-row bar; Stop neutral. Hover muted is `#373731` (≥ 4.6 on both olive and hover) instead of `#383832`; the proposed `#2F518E` hover focus is superseded by the ink focus ring |
| H4 family colours collide with the adjusted reserved colours | Modified | Full re-search with the final reserved sets plus hue gaps (§3.3). **The ≥ 15 ΔE floor for A is rejected as infeasible**: only 40 hues in three narrow islands survive it, so six families cannot stay apart; A uses 12. **Draft-grey collisions (B F4 8.6, D F3 9.9) are rejected**: draft is carried by the dash pattern, and the draft token is a near-neutral grey (chroma ≤ 0.025). **The interim swap "move C/D-dark F6 to amber around h75" is rejected**: h75 sits on C's (h65) and D's (h80) warning hue |
| H5 omitted objects and states | Accepted, relocated | X6 artboard holds the secondary-states strip, share dialog, Appearance, New-thread view; connected-nodes pill added to the prompt card. **The submitted-input line and the composer pills are not added to the scene**: Turn 3 has no submitted input, and the composer is disabled while running; both appear on X1/X6 |
| H6 unlisted test pins | Accepted | Four-way pins in §2.3 (graph-camera, tutorial, `100vh`) and per-prototype lists; the breadcrumb stays 40px; B's floating inspector has a fixed height |
| M1.1 inconsistent share themes | Accepted | X4 light, X5 dark for all; parity judged on X2 vs X3 |
| M1.2 X2 and X3 not the same scene | Accepted | Popovers moved to X6 |
| M1.3 grammar drift | Accepted | 2px gap, `octagon-x`, bottom-right lifecycle slot (B: exterior corners), one running motion |
| M1.4 B's zoom differs | Accepted | B fits into the uncovered region |
| M1.5 rubric arithmetic and questions | Accepted | 7 real answers; "which two share a family"; N6 is a failed child, N1 and N2 share Document |
| M1.6 no landing / 1-node view | Accepted | Share landing 720×450 on X6 |
| M2 B below the 55% canvas floor | Accepted | Sidebar 248, inspector 340 → 828px (57.5%) unobscured |
| M3 directions too similar in dark | Accepted, extended | A uses the charcoal canvas; D is dark-first. D also gets a deep-olive sidebar block in dark, because dark-first alone would remove D's olive identity from its default theme |
| M4 placeholders and hover = selected | Accepted | Placeholders use `--text-muted`; selected rows add a leading bar and weight 600 |
| M5 motion rules contradict | Accepted | Only Running and Stopping loop; nothing flashes; C's sweep dropped |
| M6 unmarked product decisions | Accepted, one resolved | All tagged [PD]; the "family name instead of kind" caption is resolved by keeping the raw `kind` caption, so it needs no decision |
| M7 diff counts have no token | Accepted | `--diff-add` / `--diff-del` in every table; A and D show deletions muted with "−" |
| M8 PRD drift handled asymmetrically | Accepted | `.thread-header` is the thin public bar; both drifts recorded in §8.1(7) |
| L1 sizing contradictions | Accepted, one choice | A 1.45 line height; D 15/1.55; D label stays 600; uppercase not small caps; A overview 24px; 3.2 stroke margin applied to every stroke token; `--field` rename. Edge hit area: **18px** (today's value), one of the two options the critique allowed |
| L2 §8.2 incomplete | Accepted | Items 9–18 added |
| L3 genes not independent | Accepted | Dependency note and mandatory re-check on crossover (§6.0) |
| L4 no KISS type baseline | Accepted | A uses the system stack |
| L5 share viewer has no legend | Accepted, narrowed | A compact family key on X4 and a "Key" button on X5, both [PD]; no state legend, because a snapshot holds accepted content only |
| L6 small slips | Accepted | 390×844 stated as a choice; Lantern case source corrected; B accepted-mark 3.27; ■ only inside a badge disc |
| (not in the critique) | Added | Semantic child vs native helper (`CONTEXT.md`); Fit padding 48 is today's value; breadcrumb accepted-path rule is PRD `:2305`; "Inspect codex tool work" not in the repo; PRD `:2211` concerns the annotation dock, so the ≤ 1100px overlay decision rests on PRD `:585` instead |
