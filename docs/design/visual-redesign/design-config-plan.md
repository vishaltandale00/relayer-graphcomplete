# Design types as build-time config (final plan)

**What changed and why.** You decided that designs are chosen when the app is built, not in Settings. Each design type (prototypes A–H) is a config file, and the build takes one config file as its parameter. This plan replaces the runtime-palette architecture in `theming-proposal.md`. It keeps that plan's colour-role vocabulary, validator, token cleanup and order of work, and drops everything that existed only to switch palettes at runtime.

**Snapshot and limits.** Code line references are to `main` at **`c6813890`** (#536); PRD line references are to the PRD as edited in P0. They were first taken at `18d6f23b` (#570) and re-derived at P0; §2.7 lists the corrections. I made no repo edits and ran no builds, installs, test runs or paid inference. Two reviewers checked the draft. Their reviews were not tied to a PR, so this plan certifies nothing.

**Terms used below**
- **Design type / design config.** One JSON file, `designs/<id>.json`, that names a structure and holds a palette. It may also override the structure's sizes or fonts. The file name is the id.
- **Structure.** Layout, node shape and component shapes, implemented in code. Today's app is the "classic" structure; B "Sticker" is another. A **structure file** (`designs/structures/<name>.json`) records a structure's default sizes and fonts, the colour roles it reads, and its pair contract.
- **Palette.** The colour roles, each with a light and a dark value.
- **Token.** A named CSS variable, such as `--text`.
- **Pair contract.** A structure's list of colour pairs (text on surface, ring on canvas, and so on) that must stay readable and keep states apart.
- **First paint.** The first frame a window draws.
- **Prepare step.** `npm run prepare:renderer`. npm runs it automatically as a "pre-hook" (a script that runs before another) ahead of `build`, `check`, `test`, `desktop:pack`/`dist` and the share-viewer artifact build.
- **Lab config.** A prototype config: git-ignored or untracked. It can be built and run, but never released.
- **Alias shim.** Old token names kept as aliases of the new ones while code migrates.
- **Literal-lint ratchet.** A test that counts hard-coded colours and only lets the count go down.
- **Residual.** A known exception to a taste rule, with a recorded reason.
- **CVD.** Colour-vision deficiency (colour blindness), simulated when checking that states stay distinct.

---

## 0. The answer on one screen

- **A design config** is `designs/<id>.json`. It has four fields plus an optional fifth: `format`, `name`, `structure`, `palette` (inline), and optionally `overrides`.
  - Everything else comes from the structure file: fonts, type scale, density, radii, elevation, node and edge geometry, canvas, the colour roles the structure reads, and its pair contract. A new Sticker design is therefore mostly a palette. It does not repeat about 40 numbers that every Sticker design shares.
  - `overrides` may change only tokens the structure file lists. An override the structure does not read fails validation, so a setting that does nothing fails loudly.
- **One tree implements one structure.** The value of `structure` must match the structure the checked-out code implements: `classic` on main until B4, `sticker` on the train and after B4. The field only guards against building a config against the wrong code. Changing structure means changing branch or commit, not editing a config.

> **Easy, config only:** palette, fonts, type scale, density, radii, elevation, edge curve depth, canvas grid.
> **Needs code first (size L, 1–3 weeks):** a new structure, meaning a new node shape or new panel placement.

- **The build parameter** is the environment variable **`RELAYER_DESIGN`**.
  - **Value:** a path to a config file, resolved against the directory you typed the command in (`INIT_CWD`, which npm sets). Or a bare id, which must exist in exactly one of `designs/` and `designs/lab/`. If it exists in both, the build fails instead of silently picking one.
  - **Default:** named in one place, the one-line file `designs/default`. It says `classic` on main until B4. The train switches it to `h-sticker-cocoa` in its first B2 PR.
  - **Where it is read:** in one place only, `scripts/design/build.mjs`. The existing `scripts/prepare-renderer-vendor.mjs` calls it. The `prepare:renderer` command string stays the same, and the CI portfolio manifest (`scripts/ci/verification-portfolio.v1.json:4-7`) needs no change.
  - **Why an environment variable:** npm passes it through to pre-hooks. A `--design` flag would not reach `prebuild`.
  - **Visibility:** every prepare prints one line, `design: <id> (<path>, sha256 …)`, so a variable left set in your shell is obvious. CI never sets it.
- **What the build writes.** Output goes to `desktop/renderer/design/`, which is git-ignored exactly like `desktop/renderer/vendor/` (`.gitignore:13`):
  - `design.css`: the tokens for each mode, `@font-face` rules and first-frame fallbacks;
  - `design.js`: an ES module (a JavaScript file other code imports). It holds `{id, sha256, structure, firstPaint}` from A4, and node, edge and font geometry from B2 onward;
  - `fonts/`: the font files the design uses, with their licences.
- **How the page loads it.** `styles.css` gains one first line, `@import url("./design/design.css");`.
  - `index.html`, the share template and the share contract do not change.
  - The desktop CSP (the page's content security policy) is `style-src 'self'` (`index.html:7`), which allows an `@import` from the same origin.

**One command per job**

| Job | Command |
|---|---|
| Dev run | `RELAYER_DESIGN=h-sticker-cocoa npm run desktop:dev` |
| Change the design in a running app | `RELAYER_DESIGN=designs/lab/x.json npm run prepare:renderer`, then reload. The renderer is static files served from disk by `ServeDir` (`crates/relayer-app-server/src/api.rs:330`). Use Force Reload (⇧⌘R) until A4 confirms that a plain ⌘R picks up new `design.css`/`design.js`: `ServeDir` sends no `Cache-Control`. Only the launch frame's background waits for a restart. |
| Build / check / test | `RELAYER_DESIGN=… npm run build` / `check` / `test`. **With the variable unset, these reset the prepared design to the default.** This also changes what a running dev app shows on its next reload. |
| Packaged dev app | `RELAYER_DESIGN=… npm run desktop:pack`. electron-builder ships `desktop/renderer` whole as an extra resource (`electron-builder.mjs:92`), including `design/`. |
| Release | `npm run desktop:dist`. Refuses lab configs and non-default designs (PD-17). |
| Share-viewer artifact | `npm run build:public-share-viewer-artifact -- --output <dir>`. It **always uses the committed default** and ignores `RELAYER_DESIGN` (§2.2). |
| Preview a design in the share viewer | `RELAYER_DESIGN=… npm run prepare:renderer`, then the existing fixture server `scripts/fixtures/public-share-embed.mjs`, which serves `desktop/renderer` directly. No artifact needed. |
| Check a config without building | `node scripts/design/validate.mjs designs/lab/x.json` |

**What changes from the old plan**

| Dropped (existed only for runtime switching) | Kept |
|---|---|
| `data-palette` attribute and selectors | `data-theme` stays exactly `light` or `dark` (the resolved appearance). Node Details depends on it (`node-detail-runtime.js:545`, `:550`). |
| Preload `sendSync` palette read; palette in Settings; the A7 theme picker | System / Light / Dark as a runtime user preference (A1), independent of the design |
| Generating palettes into the committed `styles.css`; the committed palette manifest | The ~45 colour roles (70 values per mode), the rename set and the alias shim (old §2.2) |
| Lab injection with `RELAYER_LAB_PALETTES` + `insertCSS` | A git-ignored lab folder (now for whole configs); the canary; screenshot evidence |
| Multi-palette CSS in one build (~3.4 KB each) | The validator's layers, per-structure pair contracts, the palette engine and the importer |
| Share-viewer fallback copies of *every* palette | The share viewer's first-frame fallback, for the one built design |
| Separate palette files and a palette lab folder | Palettes live inside the design config |

New in this plan:
- a structure file per structure that holds its shared tokens and contract;
- a per-build design identity (id + sha256) recorded in the packaged app and printed on every prepare;
- guards against stale, mismatched or lab output reaching tests, packs, releases and the share artifact;
- lab status decided by where a file lives and whether git tracks it, not by a field inside it (§1.7).

---

## 1. The config schema

### 1.1 Files

| Path | Git | What it holds |
|---|---|---|
| `designs/<id>.json` | committed | Design configs. The id is the file name. |
| `designs/default` | committed | One line: the default design's id |
| `designs/lab/<id>.json` | **ignored** | Prototype configs. They never block anyone. |
| `designs/structures/<name>.json` | committed | Token defaults (fonts, type, density, radii, elevation, node, edge, canvas); the colour roles the structure reads; pair contract; alias groups; implemented gene values |
| `designs/fonts/<id>/` | committed | WOFF2 files, `OFL.txt`, `font.json` (family, axes, ranges, source, sha256) |
| `scripts/design/{schema,build,validate,color,import-palette,canary}.mjs` | committed | Schema check (plain JS), generator, validator, colour maths, tooling |
| `desktop/renderer/design/` | **ignored** | Build output (§2.2) |

- **Why a repo-root `designs/` folder.** `desktop/renderer` is excluded from `app.asar` (`!renderer/**/*`, `electron-builder.mjs:63`) and shipped whole through `extraResources` (`:92`). The share artifact ships the files its builder lists. Configs at the repo root therefore never ship; only the generated output does.
- **Schema check: plain JavaScript** in `scripts/design/schema.mjs`. A config has about five fields, so no new root dependency is needed. There is no generated JSON Schema and no `$schema` line in configs until someone needs editor autocomplete.

### 1.2 Structure tokens (defaults in the structure file; a config may override)

These compile to CSS custom properties in `design.css`. Values marked **(JS)** also go into `design.js`.

**Classic** tokenises colour only: its sizes stay in today's CSS until B4 deletes it. **Sticker** tokens arrive in B2, where they are used.

| Token group | Type | Compiles to | sticker default (H) |
|---|---|---|---|
| colour roles | from the config's `palette` | ~45 roles + `canvas-grid` + 12 family + 8 chart values per mode → `:root` / `:root[data-theme="light"]` blocks; `firstPaint` **(JS)** from `bg` | (from palette) |
| `fonts.{ui,display,mono}` | font id or `"system"` | `@font-face` + `--font-ui/-display/-mono`; families to await **(JS)** | `figtree`, `bricolage-grotesque`, `dm-mono` (see PD-8) |
| `type.scale`, `type.floor`, `type.bodyLineHeight` | px list, px, number | `--fs-1…--fs-7` (named by step, not by size), `--lh-body` | `[12,13,14,16,20,28,32]`, `12`, `1.55` |
| `density.row`, `density.control.{sm,md,base,lg,xl}` | px | `--row`, `--ctl-*` | `36`; `28/32/36/40/44` |
| `space.unit` | px | `--space` (multiples via `calc`) | `4` |
| `radius.{row,card,prompt,panel,pill}` | px | `--r-*` | `10/16/20/24/999` |
| `elevation.{light,dark}.{card,float,lift,pop}` | CSS shadow strings | `--shadow-*` per mode | light: soft shadows in K8 ink; dark: `none` × 3, pop `0 16px 48px rgba(0,0,0,.5)`. A palette with a different ink overrides these. |
| `node.*` | px / numbers | `--node-*` + **(JS)** layout bounds, edge clip, zoom tiers | all ~20 constants from H's `geometry.json`: `height 36`, `disc 28`, `icon 18`, `maxWidth 248`, `stroke 1.5`, `ring {2,2}`, `tiers {overviewBelow 0.6, detailAbove 1.4}`, `runningArc {width 3, periodMs 1400}`, plus disc inset, title x, right padding, badge radius, caption gap, clip, zoom `fitCap 1.25` and the rest |
| `edge.{width,curvature,clearance}` | px, curve depth as a fraction of edge length (0 = straight), px | **(JS)** stroke and path | `1.5`, `0.12`, `4` |
| `canvas.grid` | `"none"` or `{dots, spacing}` | `.graph-stage` background via `--canvas-grid-image` / `--canvas-grid-size` | `"none"` |

**Never in a config (product behaviour or structure code).** The PRD pins these, or they are coupled across CSS and JS, so they stay in structure code and are checked by tests:
- #570's layout: the equal default split, the 12px divider, the 280px minimum pane and the persisted ratio. These are coupled across `styles.css:299` (`calc(100% - 292px)`) and `workspace-layout.js:36-38` (PRD READ-002).
- `--sidebar` and `--inspector` widths and their breakpoint and collapsed values. These are structure CSS; v1 has no `layout` group.
- 3 × 52px turn rows;
- explicit state glyphs and labels;
- Stop stays neutral (PRD `:2269`);
- the focus ring uses `--text`.

**Authoring palette (optional, later).** An `authoring` block (the `--relayer-*` names) waits for PD-A1.

### 1.3 What can vary, and what it costs

In v1 the config's only code-selecting field is **`structure`**, and each tree implements exactly one value (§0). Every other code gene has one implemented value per structure, so the structure file declares it. A gene becomes a config field only if one tree ever implements two values for it.

| Gene | Code it touches (main) | classic | sticker (H) | Other values: honest cost (code + tests) |
|---|---|---|---|---|
| **`structure`** (umbrella) | Component rules in `styles.css` (319 lines, 1,133 rules); JS geometry | implemented | **B2: L, 3–5 weeks** | `orbit` (A/E/F): **L**, shares ~54 of 76 token names with Sticker. `index` (C), `stamp` (D): **L** each, both retired. Keeping two structures buildable in one tree doubles every later UI PR (PD-18). |
| Node shape | Node markup and DOM measure (`workspace.js:4448-4458`); `graphNodeLayoutBounds` (`:285-291`) and the CSS-coupled `.graph-node{width:164px;transform:translate(-50%,-23px)}` / `height - 23` (`:288`); edge clip (`:408`, `:4586-4590`); camera fit; `graph-layout.js`'s fixed 960×640 world and overlap; `graph-camera.test.mjs` pins | 46px circle glyph (CSS), label below | 36px pill + 28px disc; detail and overview tiers | circle with label to the right (A): **M**; index card (C): **M–L**; stamp tile (D): **M**. Each needs markup, clip, fit, tier tests and repinned camera tests. |
| Edge style | `<line>` plus a second hit `<line>` and annotation badge midpoint (`workspace.js:4596-4598`); `graphEdgeSegment` clips circles only (`:408`) | straight | arc | Arcs as `<path>` (including hit target and badge midpoint) plus rounded-rectangle clipping: **S–M**, in B2. After that, straight is `curvature: 0`. |
| Type-colour channel | Node CSS plus a `data-family` attribute on nodes (families are not drawn today) | none | solid disc | icon stroke (A): **S–M**; tab (C): **M**; whole tile (D): **S–M**. Each also needs its own contract rule and a family re-search per palette (tooling exists). |
| Panels and prompt placement | Grid `styles.css:80-86`; #570 split `:290-310`; `.interaction-banner` | bordered cards in the split; prompt banner in flow | floating cards; prompt card over the canvas; camera fit leaves room for it | compact strip (A), editorial band (D): **M** each. All must keep #570's split (PD-16). |
| Canvas | `.graph-stage` background | dots (CSS) | flat | A sticker **token** (`canvas.grid`). Registration crosses (D): **S**. |
| Running ink, accent rationing | palette aliases | — | — | **Palette**, not code (§1.7 alias rule) |
| Density, fonts, elevation | tokens | — | — | **Token**. Fonts need B1's re-measure once. |

A config naming a structure the tree does not implement fails with "this tree implements structure Y; config asks for X".

### 1.4 H as a config

```json
{
  "format": 1,
  "name": "H · Sticker × Cocoa",
  "structure": "sticker",
  "palette": {
    "roles": {
      "bg":             { "light": "#F7F9F7", "dark": "#0F100F" },
      "canvas-bg":      { "light": "#D9DCD9", "dark": "#0F100F" },
      "running":        { "light": "#D43064", "dark": "#DE5276" },
      "selection-ring": { "light": "#725345", "dark": "#ECC8B8" }
    },
    "families": { },
    "chart": [ ],
    "residuals": [ ]
  }
}
```

- The file is `designs/h-sticker-cocoa.json`. No `overrides` are needed, because H *is* the Sticker defaults.
- The excerpt shows 4 of the ~45 roles. Values come from `gen2/H/tokens.mjs`. The full block also has 6 family discs, 4 chart series, and residuals, each pointing at a recorded decision.
- `designs/structures/sticker.json` holds the §1.2 sticker column, the colour-role list, the pair contract (with the revised running rule) and the alias groups.

### 1.5 Today's app as a config

```json
{
  "format": 1,
  "name": "Classic (today's look)",
  "structure": "classic",
  "palette": { "roles": { "bg": { "light": "#fafafa", "dark": "#0b0c0d" } } }
}
```

- **The classic palette** holds today's 13 colours mapped onto the roles:
  - dark `bg #0b0c0d`, `surface #101214`, `field #17191c`, `text #f1f2f3`, `text-muted #969ba2`, …;
  - light `bg #fafafa`, …;
  - `accent-text` light `#b45309`, today's amber "blue" (`styles.css:26`), until A3's side-by-side review decides otherwise;
  - plus the ~190 literals A3 turns into roles.
- **`designs/structures/classic.json`** lists the roles only. It has no size tokens and an empty `pairs` list, so classic is checked for completeness only.
- **Lifetime.** Classic is deleted on the train in the first B2 PR, and on main at B4 (PD-18).

### 1.6 Prototypes A–H on the schema

| Proto | structure | palette | Buildable | Needs |
|---|---|---|---|---|
| **H** Sticker × Cocoa | sticker | cocoa (K8) | on the train from the first B2 PR (as its default); on main at B4 | the plan below |
| **G** Sticker × Riso | sticker | riso (K9) | after B4, config only (**S–M**) | Import `gen2/G` tokens into a copy of H's config and re-tune floors. Running shares ultramarine with selection, which is now allowed (§1.7). |
| **B** Sticker × Surly | sticker | surly | after B4, config only (**S–M**) | Import `gen1/B` tokens. Rose covers interaction, selection and running (allowed); lime means accepted. |
| **A, E, F** Orbit × Nocturne / Toffee / Mustard | orbit | nocturne, M11, K6 | **no** | new `orbit` structure (**L**) + structure file; then configs **S–M** each |
| **C** Index, **D** Stamp | index, stamp | apex, small-things | **no** | retired structures (**L** each) |
| Any palette on today's layout | classic | any | on main after A4, until B4, as a **lab** build only | classic has an empty pair contract, so completeness check only, plus a visible LAB badge |

### 1.7 Validation: what is checked, and what fails a build

| Layer | Checks | How |
|---|---|---|
| **Schema** | types, required fields, hex format, px ranges, `format` version, known font ids | `scripts/design/schema.mjs` |
| **Integrity** | `structure` is the one this tree implements; `overrides` name only tokens the structure file lists; the palette defines exactly the structure's roles per mode; referenced fonts have licence + provenance; a bare id is not in both `designs/` and `designs/lab/`; aliasing rule | validator |
| **Floors and state pairs** | text 4.5, marks 3, thin strokes 3.2, labels on fills 4.5 on every contract pair; accepted vs draft outline; stopped (neutral) vs failed; approval vs failure; failure vs running; each in normal and simulated CVD vision | validator (ports `gen2/H/contrast.mjs` and `families.mjs`) |
| **Taste** | family hue gaps; distinctness bands; residuals without a `decision` pointer | validator report only |

**Alias rule, revised for your running-hue decision.**
- A palette may alias `running`, `running-text` and `running-soft-bg` to interaction roles (`accent-text`, `selection-ring`, `primary`).
- It may never alias across accepted, draft, danger, warning or stopped, and never from those to interaction.
- The "running vs selection hue" check leaves the colour tiers. Distinctness is proved on the structure instead: a running node has the arc, badge and caption; a selected node has only the static ring; under reduced motion the badge and caption remain (checkpoint C9).

**What is lab.** A config is lab if **any** of these holds:
- it is under `designs/lab/`;
- it is outside `designs/`;
- git does not track it (`git ls-files --error-unmatch <path>`).

Every other config is committed. Release scripts use this one check. There is no `status` field, so a copied config cannot claim to be shipped.

**Build outcome**

| Failure | lab | committed |
|---|---|---|
| Schema or integrity error | fail | fail |
| Floor or colour state-pair failure | warn; build proceeds with a LAB badge (`body::after`) listing the failure count | warn until the PRD adopts the floors (PD-5), then **fail** |
| Taste finding | report | report |
| `desktop:dist`, preview and stable release | **refused** | default design only (PD-17) |
| Share-viewer artifact | not applicable: the builder always regenerates the committed default (§2.2) | same |

Explicit state glyphs and labels are enforced in every build by structure tests (PRD `:289`), not by colour checks.

---

## 2. Build pipeline

### 2.1 Flow

```
RELAYER_DESIGN (or the id in designs/default)
  └─ scripts/prepare-renderer-vendor.mjs   (npm run prepare:renderer; runs before build/check/test/pack/dist/artifact)
       ├─ copies vendors (unchanged)
       └─ scripts/design/build.mjs: load config → merge structure defaults + overrides → resolve fonts → validate (§1.7) → write:
            desktop/renderer/design/design.css   tokens per mode, @font-face, first-frame fallback, LAB badge
            desktop/renderer/design/design.js    export default Object.freeze({ id, sha256, structure, firstPaint, …B2: node, edge, fonts })
            desktop/renderer/design/fonts/*      only the fonts this design names, plus licences
          → prints "design: <id> (<path>, sha256 …)"; returns the list of files it wrote
```

### 2.2 Who reads what

| Consumer | How it picks up the design | Change |
|---|---|---|
| Renderer CSS | `styles.css` line 1 `@import url("./design/design.css")`; the hand-written `:root` (`:1`) and light block (`:26`) move into `designs/classic.json` in A4 | 1 line + deletions |
| Renderer JS | **B2, not A4:** `src/product-workspace/workspace.js` imports `../../design/design.js`, replacing `GRAPH_NODE_ICON_RADIUS` (`:79`), `:188-190`, `:425-427` and the CSS-coupled node offsets. Add the module to `desktop/shared/telemetry-module-inventory.mjs` (as #570 did at `:45`). | S (in B2) |
| Electron main (first paint) | `await import(pathToFileURL(join(rendererDirectory, "design/design.js")))` before `createWindow` (`index.mjs:174-176`, `:619`). `appearance.mjs` `firstPaint(mode, design)` replaces the literals at `window.mjs:46` and `register-ipc.mjs:374`. | S |
| Packaged app | Copied with `renderer/` (`electron-builder.mjs:92`). `relayerDesign: {id, sha256}` is added to `extraMetadata` (`:40-53`, next to `relayerReleaseSourceCommit`); the design id also goes into telemetry and bug-report context. `verify-bundled-app-server.mjs` (which already checks a generated vendor file at `:67`) checks that `renderer/design/design.js` exists and that its sha256 equals `relayerDesign`. Dev pack names gain `-<design>` when the design is not the default. | S |
| Release | `desktop/release/build-release.mjs` refuses lab configs and non-default designs (PD-17). The check compares the prepared sha256 with one recomputed from the git-tracked default config, structure and font files. | S |
| Share viewer artifact | The builder **ignores `RELAYER_DESIGN`**. It regenerates the committed default in-process from git-tracked inputs into its staging area, and adds the file list `build.mjs` returns to `browserResources`. That list is literal today (`build-public-share-viewer-artifact.mjs:11-44`), so the returned list is appended to it. The template links `styles.css` (`template.js:116`, `:133`), whose `@import` resolves beside it in `assets/<commit>/`. **Why default-only:** every build from one commit publishes under the same immutable `assets/<productCommit>/` path (`:80`), and the clean-tree check (`:77-78`) cannot see ignored lab files. The design bytes are covered by `artifactSha256` once they are in `files`, so no new manifest key is needed. The contract's `requiredResources` (`contract.json:92`) is **unchanged**: a new logical asset would break old-manifest hosting, because `viewerAsset` throws on a missing key (`template.js:36-40`). | S |
| Share first frame | `design.css` includes `@media (prefers-color-scheme:light){:root:not([data-theme]):not([data-viewer-theme="dark"]){…}}` and `:root[data-viewer-theme="light"]:not([data-theme]){…}`, which match until `setTheme` runs (`public-share-viewer/main.js:16-26`) | in the generator |
| Eval review workspace | The Eval app hosts the product renderer (`productRendererDirectory`, `eval-main/index.mjs:66`, `:186`) and proxies review requests to it (`eval-main/web-host.mjs:126`), so it follows automatically. The Eval dashboard itself serves `eval-renderer` (`web-host.mjs:161`, `:192`), see PD-6/13. | none |
| Published shares | Keep the artifact they pinned (`contract.json:99`). Shares published before B4 stay classic. | none |

### 2.3 Appearance stays a runtime preference (A1; decided)

`settings.appearance` becomes `system|light|dark` and drives `nativeTheme.themeSource`. The pieces:
- **Bootstrap.** In the desktop app, `theme-bootstrap.js` sets `data-theme` from `matchMedia("(prefers-color-scheme: light)")`: main applies the saved preference to `nativeTheme` before the window exists, so the query already reports the resolved mode. Browser-hosted pages (the Eval review and judge) keep today's saved-or-dark bootstrap, so PD-6/13 stays open and the judge browser needs no `colorScheme` pin. `src/ui.js` listens for OS changes while the preference is System.
- **Meta tag.** `<meta name="color-scheme">` becomes `light dark` (`index.html:6`).
- **One pure main-process module.** `desktop/main/appearance.mjs` replaces the clamps at `index.mjs:408-409`, `register-ipc.mjs:208` and `:371-374`, and `window.mjs:46`. The renderer clamps (`src/ui.js:6-10`, the bootstrap) are deleted.
- **Explicit modes apply directly.** When the preference is Light or Dark, the renderer sets `data-theme` from it exactly as today; only System reads `matchMedia`. 16 evidence and desktop-test scripts stub `relayer:appearance-read` with a fixed `"light"` or `"dark"` and never set `nativeTheme.themeSource`, so they keep rendering the mode they ask for instead of the host's OS mode.
- **Settings row.** The "Theme" row (`index.html:185`) offers System · Light · Dark, System first. The label and the pinned ids `appearanceSelect` and `appearanceDescription` are kept.
- **Migration.** A saved `light` or `dark` is kept. An install with no saved value becomes `system`, as decided. Defaults are never written eagerly.
- **Scope.** `data-theme` stays binary. The design never touches it.

### 2.4 Determinism and freshness

- **Output is a pure function of its inputs:** config bytes, structure-file bytes, font bytes, and the sha256 of the `scripts/design/*.mjs` sources (no hand-kept version number). Keys are sorted, there are no timestamps, and each file carries a header comment with the id and sha256.
- **Stale-output guard in tests.** A vitest `globalSetup` compares the prepared `design.js` `{id, sha256}` with `RELAYER_DESIGN ?? default` recomputed from source. If they differ, it fails with "prepared design is X; run `npm run prepare:renderer`". `pretest`/`precheck` always prepare, so only a direct `npx vitest run` can hit it.
- **Evidence scripts without a pre-hook.** `evidence:public-share-viewer`, `evidence:model-selector`, `evidence:share-publish-restart` and `eval-app:dev` render whatever was last prepared. Every evidence script therefore records the design it actually rendered, read from the prepared `design.js`, not from the environment variable.
- **Packs and releases** compare sha256, not just the id (§2.2).
- **CI's quick chapter** already runs `prepare:renderer` (`scripts/ci/run-chapter.mjs:122-132`) with the variable unset, so CI always tests the branch's default design.

### 2.5 Tests and CI matrix

- **The default suite runs against the branch's default design.** That is classic on main until B4, and H on the train from the first B2 PR. Structure-specific pins therefore always match the code on that branch.
- **Tests that must cover every design** do not read prepared files. They call the loader and generator in-process for each committed config (parametrised; about 50 ms each). Adding or editing a design needs **no test-file change**.
- **Token-value pins that read `styles.css`** (13 test files) move to reading the config through the loader in A3/A4.
- **A CI matrix is not needed in v1.** The parametrised test already covers all committed configs. Add a `design-matrix` job once a second design ships. Per design it would run `RELAYER_DESIGN=$d npm run prepare:renderer` plus the in-process design and share-viewer tests, with no Electron.
- **CI wiring** (`scripts/ci/affected-modules.v1.json`):
  - map `designs/` in `chapterOwners` with `["vitest","packaging"]` and the design test files, because the default config changes the shipped renderer;
  - map `scripts/design/` in `scriptOwners`.

### 2.6 Git-ignore additions

`desktop/renderer/design/`, `designs/lab/`.

### 2.7 Corrections to the old plan's citations

- `ServeDir` is now at `api.rs:330` (was `:326`).
- The appearance clamps are at `register-ipc.mjs:208` and `:369-376` (were `:168`/`:329-336` at `18d6f23b`, `:156`/`:322` before), and `index.mjs:408-409` (was `:407-408`).
- `styles.css` is now 319 lines, 109,329 B, 1,133 rules and 534 `var(--…)` uses.
  - It contains 223 hex and 82 `rgb(a)` literals, and 108 uses of the `html[data-theme="light"]` selector (the old "57 rules" was counted differently).
  - #570 added new literal shadows (`:292`, `:297`).
  - Re-derive all of these at A3.
- **Packaging.** `desktop/renderer` is excluded from `app.asar` (`electron-builder.mjs:63`) and ships via `extraResources` (`:92`).
- **Eval.** The review workspace follows the product renderer through `eval-main/index.mjs:66`/`:186` and the proxy at `web-host.mjs:126`, not `web-host.mjs:161`/`:192` (those serve `eval-renderer`).
- **Node geometry.** `workspace.js:79` is `GRAPH_NODE_ICON_RADIUS = 24`. The 46px glyph exists only in CSS.
- **PRD anchors re-derived.**
  - Stop is neutral at `:2269`.
  - The floating annotation editor is at `:2327` (#570 made it an overlay; pin at `test/workspace-keyboard.test.mjs:595`).
  - Explicit states are at `:289`.
  - Appearance is at `:1349` (§10.1). `:595` is the historical Slice 1 table, not the current tracker; P0 added the planned System appearance row to the §15C.1 evidence table.
  - The old `:2195`, `:2231` and `:2390` citations are dropped.
- **#570 changed the layout H was drawn on.**
  - At widths of 1101px and up, the fixed `--inspector` column became a draggable split: equal default, 280px minimum per pane, ratio persisted (`styles.css:299-309`, `workspace-layout.js`, IPC `register-ipc.mjs:139-146`).
  - Environment became an overlay (`styles.css:292`).
  - H's fixed 340px floating inspector and in-inspector Environment row conflict with this. That is PD-16.
- **Probable existing bug, not confirmed.** Zoom-scaled edge width is set through an inline `style` attribute via `innerHTML` (`workspace.js:4598`). The desktop CSP has no `'unsafe-inline'` (`index.html:7`), which would block it, so desktop edges probably stay at the CSS 1.5px. The share viewer allows `'unsafe-inline'` (`template.js:74`), so edges there scale.
  - Check the desktop dev console for "Refused to apply inline style" during A4.
  - If confirmed, set the width through CSSOM (`element.style.strokeWidth`) or a CSS variable before B2 routes `edge.width` through it.

---

## 3. The prototyping loop

```
idea (3 colours / a reel)
  → docs/design/palette-engine/engine.mjs
  → node scripts/design/import-palette.mjs <tokens.mjs> --structure sticker --name "X" > designs/lab/x.json   # prototype TOKENS + FAMILIES → a config
edit designs/lab/x.json                                    # palette, or overrides of structure tokens
node scripts/design/validate.mjs designs/lab/x.json        # the exact failing pairs to hand-tune
RELAYER_DESIGN=designs/lab/x.json npm run prepare:renderer # then reload the running app (first time: npm run desktop:dev)
npm run evidence:designs -- designs/lab/x.json             # light + dark tiles from the existing fixtures + validator report
keep it → git mv designs/lab/x.json designs/x.json → one PR, no code, no test edits
```

- **Engine and validator.** Commit the engine and the 29 engine palettes under `docs/design/palette-engine/`. The colour maths go to `scripts/design/color.mjs`, shared by the validator and the contract test.
  - **Copy the prototype sources in P0.** `gen2/H/{tokens,contrast,families,geometry}.mjs`, `geometry.json`, `gen2/G` and the palette space were copied from the temporary prototype workspace into `docs/design/visual-redesign/sources/` (their original layout, so imports resolve). P0 moves them to their final homes.
- **Canary.** `node scripts/design/canary.mjs` writes `designs/lab/canary.json`: the default config with every colour role set to one loud colour. It builds like any lab config. Anything that still looks normal is a hard-coded colour. Use it throughout A3.
- **Evidence.** `evidence:designs` is one thin Electron script. For each design × appearance it:
  - generates the design into a **temporary copy** of the renderer folder and points the app server at it (the server already takes `webDirectory`, `index.mjs:456`). Your prepared design and running dev app are never touched;
  - loads the existing fixtures: Lantern 2×2, stop-run, approval and `fixture.node-detail`;
  - switches mode through `nativeTheme.themeSource`;
  - writes PNG tiles plus the `{id, sha256, mode}` it actually rendered, and checks that tokens resolve, no region is blank and there are no CSP errors.

  There is no golden-image gate (no pixel comparison against saved reference images).
- **Design-canvas export** (`export-kit.mjs`, the same token names as a kit block for canvas boards) is postponed until someone needs the canvas round-trip.
- **Time per new design on an existing structure** is unchanged from the old plan:
  - draft: about 15 minutes;
  - passing the floors: 1–3 hours;
  - on the real app: the same session;
  - shipped: ½–1 day.

  A new structure is **L**.

---

## 4. Phased plan

Sizes: **S** ≤ 1 day; **M** 2–5 days; **L** 1–3 weeks over several PRs. "Train" means the integration branch `integration/h-redesign` (`docs/agents/ci.md` "Integration trains").

| # | Where | Step | Size | Depends on | What it makes visible |
|---|---|---|---|---|---|
| P0 | main | **Docs from recorded decisions only.** Copy the prototype sources (§3) into `docs/design/`. ADR 0013: "Not decided" and Consequences say build-time designs; the CSP `font-src` consequence is dropped (fonts are same-origin). PRD §10.1: Appearance System/Light/Dark (`:1349`); "one design per build; no product setting; shares render their artifact's design"; a planned System appearance row in §15C.1. Checkpoint rows are written as **planned** checkpoints, with no pass status or evidence link; each later step fills in its row. Floors only if PD-5 is answered. | S | — | none |
| A1 | main | **Appearance**: §2.3; `test-desktop-visual-node-details.mjs` (switches mode with `applyAppearance`) gains a System leg; the 16 scripts that stub `relayer:appearance-read` keep working unchanged (§2.3); browser-hosted review keeps its dark default | S–M | — | System option; no dark first frame for light users |
| A2 | main | **Schema, validator, structure data**: `schema.mjs`; `validate.mjs`; `color.mjs` (moved from `sources/research/tmp/`); `designs/structures/sticker.json` roles + pair contract (running rule revised); H's palette as `docs/design/visual-redesign/h-sticker-cocoa.json` until B2; `import-palette.mjs`; `h-colour-spec.md` points at the JSON. Floors and state pairs **warn** (PD-5). *As built:* H's config sits beside its spec, not in the git-ignored `designs/lab/`, so the test has a committed config to check; it is outside `designs/`, so it counts as lab (§1.7), and B2 moves it with `git mv`. The engine stays in `sources/`. `import-palette.mjs` reads prototype token files (TOKENS + FAMILIES), not engine output. Family-vs-family hue gaps (`families.mjs`) and CVD floors stay report-only work for later. Colours must be opaque except roles the structure lists as `translucent` (`scrim`), and the validator also checks the structure file itself. *Open before B2 freezes the role list:* the 52 sticker roles are H's prototype set, so they include brand constants (`ink`, `white`, `cream`, `deck`) and `accent-solid-hover` (unused by components), and lack `canvas-grid` and chart values; the alias rule lets the whole running group (including `running-ink`) alias interaction, and there is no stopped group because stopped uses neutral roles; §1.7's accepted-vs-draft-outline and stopped-vs-failed pairs are not in the prototype contract, so they are not checked yet (no floor was invented). | M | P0 | none for users; configs can be validated |
| A3 | main | **Token cleanup on today's look**: hard-coded colours → roles; the light override selectors deleted; alias shim; gradients flattened; `color-mix` hovers; literal-lint ratchet; reverse coverage; ~23 colour pins converted. Gate: your side-by-side review per area, plus the surface-mapping table. | **L** | A1, A2 | light mode fixed; small dark shifts |
| A4 | main | **The build parameter**: `build.mjs`; `designs/default` = `classic`; `classic.json` + `structures/classic.json` (palette only); `@import`; `design.js` = `{id, sha256, structure, firstPaint}`; main first paint; `extraMetadata.relayerDesign`; packaging, release and artifact checks; stale guard; loader-based pins; CI owner mapping; confirm or fix the edge-width CSP bug; confirm which reload picks up changes | S–M | A3 | none for users; `RELAYER_DESIGN=<lab>` builds any palette on today's layout |
| A5 | main | Authoring tokens `--relayer-*` | S | A4, PD-A1 | new authored pages follow the design |
| A6 | main | `evidence:designs` (temporary renderer copy), canary, LAB badge | S–M | A4 | tiles per design × appearance |
| B1 | train | Fonts: `designs/fonts/` library (Figtree, Bricolage, DM Mono, ~162 KB), re-measure on `document.fonts.ready`, `font/woff2` in `scripts/fixtures/public-share-embed.mjs:82` | S | A4 | new type in H builds |
| B2 | train | **Sticker structure**, one PR per area. **The first PR** commits `designs/h-sticker-cocoa.json`, sets `designs/default` to it, and deletes `classic.json` and `structures/classic.json` on the train, so train CI tests H from day one. Then: sticker size tokens; `design.js` geometry replacing `workspace.js:79`, `:188-190`, `:425-427` and the CSS-coupled node offsets; pills and discs; edges as `<path>` including hit target, badge midpoint and pill clipping; `graph-layout.js` world size and overlap; `data-family`; floating cards reconciled with #570 (PD-16); annotations per PD-19 (PRD `:2327`); `sticker.json` contract final | **L** (3–5 wk) | A4, B1 | H on the train |
| B3 | train | Header thread-status symbol | S | B2 | ADR item 1 |
| B4 | train → main | Merge the train: H becomes main's default and classic leaves main (PD-18). Lint at zero; shim removed except the 13 permanent aliases on `.node-detail-runtime-host`; PRD evidence refreshed; OG image per PD-14 | S | B2, B3 | **H reaches users whole** |
| C | later | G and B configs (**S–M** each); Orbit structure only if wanted (**L**) | — | B4 | more real builds |

**Ordering.**
- P0 first (it preserves the prototype sources). A1, A2 and B1 can then run in parallel.
- A3 comes before A4, and A4 before any B2 PR, because B2 consumes the build parameter and `design.js`.
- A6 can run in parallel with B2.
- Track-A PRs touch only colour, tokens and plumbing. Track-B PRs may not add a colour literal; the lint enforces this.

**Decided (ADR 0013 "Build decisions"):**
- Build-time design configs with no in-product picker (supersedes PD-0, PD-1, PD-7).
- Foundation first; H lands whole through the train (PD-12).
- Installs with no saved appearance move to System (PD-2).
- Running may share selection's hue per palette, distinct by shape, motion and label (PD-11).

**Decided by the owner after this plan was written (2026-09-28; recorded in ADR 0013 "Build decisions"):**
PD-16 keep #570's split · PD-19 re-review the annotation row against #570 in the real app first · PD-18 delete classic
after B4 · PD-17 releases and the hosted share artifact use the default design only.

**Open decisions.** The rows for PD-16, PD-17, PD-18 and PD-19 below are kept for their reasoning; they are decided above.

| # | Question | Recommended | Before |
|---|---|---|---|
| **PD-16** | #570 vs H on wide windows. One option: keep #570's split, divider, ratio and Environment overlay, with H's floating inspector card filling the right pane (340px only below 1101px). The other: change the PRD's READ-002 layout. (Absorbs PD-9.) | Keep #570 | B2 inspector |
| **PD-17** | Should desktop releases use only the default design, with other designs in dev runs and dev packs only? This absorbs PD-4's new part, "hosted share artifact = default design". The artifact is default-only regardless, for integrity (§2.2). Allowing other designs there would need the design id in the asset path (`assets/<commit>-<design>/`) and in the manifest identity. The share viewer's light/dark behaviour (`data-viewer-theme`) already exists and is unchanged. | Yes | A4 |
| **PD-18** | Classic after B4. **Delete it:** every later UI PR is simpler, and structure prototypes stay on the Design canvas; `structure` then has one legal value. **Keep it buildable:** `structure` really has two values and you can build today's look beside H, at the cost of maintaining a second set of component styles and pins in every UI PR. | Delete | B4 |
| **PD-8** | Fonts: set by the structure file only, or also overridable per design config? The UI font sets pill widths and moves the layout; gen2-brief held fonts fixed per structure. | Structure default; a config may override (validator checks it) | B1 |
| **PD-10** | Colours on today's layout. With build-time designs this becomes moot: hybrids appear only as lab builds. Confirm. | Moot | — |
| PD-5 | Accessibility floors (4.5 / 3 / 3.2, H's 12px floor) in the PRD. Until then, floors and colour state-pairs only warn. | Brief §2.5 numbers | before floors become a gate |
| **PD-19** | ADR 0013 item 2 (40px collapsed "Add annotation" row) versus #570's floating annotation editor (PRD `:2327`, pin `test/workspace-keyboard.test.mjs:595`), which already reserves no space when hidden | Re-review against #570 | B2 annotations |
| PD-A1 | Authoring tokens (4 parts, old §2.8). Also: does the agent guidance palette (`graph-presentation-guidance.ts:17`) stay one fixed text, updated once at B4, rather than following the build's design? | Tokens; fixed text | A5 |
| PD-6 / PD-13 | Eval dashboard, judge and trace pages: follow the OS or stay dark; tokenise them or amend ADR `:76` | Your call | B4 |
| PD-14 | OG link image: recolour the SVG or generate a PNG | **Decided 2026-09-29:** the design build generates the SVG (`design/share-og.svg`) from the configured dark roles, families and fonts. Since the logo redesign the title is the drawn wordmark from `relayer-mark.js`, not typeset in the display font | B4 |
| PD-15 | Tutorial coach mark drops its private blue | Your call | A3 |

---

## 5. Verification (AGENTS.md)

| # | Checkpoint | Authority | Smallest deterministic test | Tier | Step |
|---|---|---|---|---|---|
| C1 | A bad config fails with a named error for each class in §1.7. Lab is decided by location and tracking: an ignored or untracked config is refused by release even if copied from a committed one. A bare id found in both folders fails. | integrity | `test/design-config.test.mjs` (fixtures in memory, plus a temp git repo for the tracking check) | warm | A2/A4 |
| C2 | Every committed config meets its structure's floors and colour state pairs | brief §2.5, report only until PD-5, then a hard gate; PRD `:289` for explicit states | `test/design-contract.test.mjs`, parametrised over `designs/*.json` | warm | A2 |
| C3 | Output is byte-identical across runs; the hash covers config, structure file, fonts and generator sources; every `var(--x)` in `styles.css` is defined by every committed design; the prepared output matches its source | integrity | `test/design-build.test.mjs` + `globalSetup` guard | warm | A4 |
| C4 | No colour literal outside generated output (CSS, JS, main, `viewer.css`), except the alias shim | design integrity | literal-lint ratchet test | warm | A3 |
| C5 | Preference → resolved mode; OS change applies in place; migration; first paint = design `bg` | PRD `:1349`; ADR 0013 item 3 | `test/appearance.test.mjs` (pure module, bootstrap in HappyDOM with stubbed `matchMedia`, IPC with a fake `nativeTheme`) | warm | A1/A4 |
| C6 | `data-theme` stays binary; an appearance flip leaves authored pages, input and focus alone | PRD §6.2A | extend `test/node-detail-runtime.test.mjs` | warm | A1 |
| C7 | The artifact contains the design files and every `@import` and `url()` resolves; it ignores `RELAYER_DESIGN` and contains the committed default; the template and `requiredResources` are unchanged | share contract | extend `test/public-share-viewer-artifact.test.mjs` (its import and `url()` checks at `:55-68`) | warm | A4 |
| C8 | JS geometry comes from the config (bounds, edge clip against pills, arc path, hit target, tiers) | graph fit | repoint `test/graph-camera.test.mjs` at the loader | warm | **B2** |
| C9 | Running is distinct from selection by shape, motion and label, including under reduced motion | ADR 0013 build decision; PRD `:289` | HappyDOM graph render test | warm | B2 |
| C10 | Fonts ship with licences; re-measure after `fonts.ready` | PRD §14.3 | font provenance test + stubbed `document.fonts` layout test | warm | B1 |
| C11 | Stop stays neutral in every shipped design × mode; draft stays dashed | PRD `:2269` (Stop); brief-level for draft | `test:desktop:stop` sentinels, run per design via `RELAYER_DESIGN` | heavy | A3/B2 |
| C12 | The packaged app contains the intended design (sha256 matches `extraMetadata.relayerDesign`); release refuses lab and non-default designs (PD-17) | release integrity | `verify-bundled-app-server.mjs` + a release-guard unit test | warm + pack | A4 |
| C13 | The real app paints each design × appearance (tokens resolve, nothing blank, no CSP errors, including the edge-width style) | your visual review (ADR 0013); brief-level, no PRD line | `evidence:designs` + your review | heavy | A6 |

**Warm loop** (well under 10 s, no Electron):

```
npx vitest run test/design-*.test.mjs test/appearance.test.mjs test/node-detail-runtime.test.mjs test/graph-camera.test.mjs
```

Add the pin files a PR touches.

**Heavy entry points before handoff.** None needs paid inference.
- `npm run check`, `npm run build`
- `test:desktop:stop`, `test:desktop:visual-node-details` (light, dark and a System leg), `test:desktop:node-detail-csp`, `test:desktop:project-new-thread`
- `evidence:public-share-viewer` and `evidence:public-share-embed` (add a light leg)
- `desktop:pack` once in A4
- `evidence:designs`

For a non-default design, run these with `RELAYER_DESIGN` set. Record the design id and sha256 **read from the prepared `design.js`** in the evidence. Note that `check`, `build` and `test` reset the prepared design to the default when the variable is unset.

**Unmapped today (fall back to `npm run check`; report the gap).**
- No existing fixture renders a draft node in the real app, so C11's draft leg is a gap.
- #570's wide-layout geometry under H has no deterministic test until B2.
- Floors and draft-dashed are brief-level, not PRD promises, until PD-5.
- C13 has no PRD authority line.

**Adversarial review targets.**
- Is any product behaviour hidden in a config field or structure token?
- Can the alias rule merge any two states other than running and selection?
- Does anything stale survive a design switch: fonts, the first-paint colour, a running dev app, evidence output?
- Can a lab or untracked config reach a release or an artifact?
- Pin subsumptions.
- Does anything from the train reach main before B4?

Record the reviewer, the commit, the scope, the verdict and any open findings in each PR. Without a PR, a review certifies nothing.

---

## Appendix: corrections not applied, or applied differently

- **Palettes referenced by id from `designs/palettes/` (review 1).** Replaced by review 2's inline palette. It keeps one file per design type, as you asked, and palette reuse across structures has no user while one tree implements one structure.
- **"The PRD has no Stop-stays-neutral promise; mark C11 brief-level" (review 1).** Wrong: PRD `:2269` says Stop controls and the stopped notice use neutral theme colours. C11 cites it. Only the draft-dashed leg is brief-level.
- **"List every sidebar/inspector breakpoint value as a structure token" (review 1, one of two options).** The other option was taken: layout stays structure code in v1. It is coupled to #570's READ-002 behaviour, and no prototype varies it without also changing structure.
- **"Refuse the artifact unless the prepared sha256 matches" (review 1, one of two options).** The other option was taken: the builder regenerates the committed default in-process. That is one path with no way to be stale.
- **"If PD-17 = no, put the design id in the artifact path" (review 2).** Recorded as the option inside PD-17, not built. The artifact is default-only now because the shared asset path requires it.