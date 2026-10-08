# Issue #699: artifact viewer, phase 3

Product meaning is PRD §6.6.3, §6.6.9 and §11.11, and ADR 0014. P3 adds Office documents to the viewer: Word (`docx`), Excel (`xlsx`) and PowerPoint (`pptx`), with a deck able to open at a slide. No paid inference ran, and no release claim is made.

## Renderer decision (2026-10-08)

The prototype's PowerPoint renderer, pptx-preview, publishes no source and drew no bars in the fixture deck's chart. P3 uses MIT-licensed `@jvmr/pptx-to-html` instead; it draws the same fixture deck, chart included. Word uses `docx-preview` (Apache-2.0). Excel uses SheetJS 0.20.3 (Apache-2.0), taken from SheetJS's own site because the npm copy (0.18.5) carries two known vulnerabilities; its tarball is committed in `vendor/sheetjs/`. `scripts/prepare-renderer-vendor.mjs` bundles all three into `desktop/renderer/vendor/artifact-office.js`, which only artifact views load, and writes `artifact-office.LICENSES.txt` beside it with every bundled package's licence.

## Checkpoints and production seams

| Checkpoint | Promise | Deterministic observation |
| --- | --- | --- |
| ART-012 | Office kinds render. Guidance covers calculated values and decks with charts. | Graph-core accepts the three kinds and a slide only on decks (`artifact_details_are_checked_before_any_write`). The host fingerprints them by extension (`artifact-files.test.ts`). `test/artifact-viewer-main.test.mjs` loads the viewer's own Office page and bundle in Chromium: the Word title and bullets, both Excel sheets with the saved totals, four slides opened at slide 3 with the chart's four bars, and the note location for each. `artifact-layer-guidance.test.ts` asserts the kinds and both guidance rules. Desktop run: each kind opens in the real app, and a note on the deck names its slide. |

Agent previews of the three Office layers render through the same page (ART-005 in the desktop run).

## Known limits

- Deck charts may still draw imperfectly: the fixture chart's axis labels are cut off. Guidance says to export a PDF next to any deck with charts.
- Spreadsheets show the values the file saved. A formula saved without its value renders blank, so guidance says to save calculated values.
- A sheet shows its first 1000 rows and 100 columns, with a note saying so.
- Any part of an Office file over 32 MB (about a million spreadsheet cells) shows a "too large" message instead of being parsed.
- An Office file over 50 MB, or one whose contents would expand past 250 MB, shows a "too large" message instead of being parsed. A file whose zip headers disagree, or whose contents expand past their declared size, shows as damaged.
- The Chromium render test runs where a Playwright browser is installed; CI's Vitest job has none, so there it checks the served bundle and page, and the desktop run covers rendering.

## Heavy entry point

`npm run test:desktop:artifact-viewer` runs the real `desktop/main/index.mjs` with the `fixture.artifact-viewer` harness in place of Codex, and checks P1, P2 and P3 together. `RELAYER_ARTIFACT_VIDEO=<file>.mp4` records the run with captions.

## Source identity

The recorded run and `results.json` come from commit `a37eb094` with a clean working tree: 44 checks passed, 0 failed. `results.json` records that commit and tree state itself (`source`); a later source change needs a new run.

## Files

- `artifact-viewer-p3-demo.mp4`: the recorded run.
- `results.json`: every check from the recorded run.
