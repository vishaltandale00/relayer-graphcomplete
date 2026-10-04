# Archive icon hover evidence

[Short hover video](hover-demo.mp4) shows the production desktop renderer with real accepted graphs from a synthetic, inference-free harness. The pointer leaves the sidebar, hovers the selected standalone chat, hovers a project chat, and leaves again. Assertions verify every other archive icon stays hidden. The visible cursor marker is a noninteractive overlay following actual Chromium pointer events; captured frames omit the OS cursor.

[Full archive journey](archive-demo.mp4) continues with real Rust API archive, Undo, retained reading position/draft, Settings search/open and process restart. Every scenario verdict, source hash, binary hash and both video hashes are in [manifest.json](manifest.json). Paid inference calls: zero. This is local desktop evidence; release and installed-app acceptance remain separate.

## Verification mapping

- ARC-003 visibility: `scripts/test-sidebar-overflow.mjs` checks the real sidebar projection and CSS at rest, on row hover and keyboard focus, and after pointer focus leaves; selected, standalone and project rows retain layout. Six width/rail scenarios plus Settings/Eval remain covered.
- ARC-002 availability: the same runner checks a busy row reveals a dimmed disabled control with its reason; `test/thread-archive.test.mjs` retains all active-state checks.
- Real pointer/archive seam: `scripts/capture-thread-archive-evidence.mjs` moves the pointer, checks opacity and hit targeting, then clicks. The video intro directly asserts hover visibility and disappearance.
- Renderer evidence integrity: `npm run evidence:share-preview` regenerated the renderer-wide social-preview receipt and synthetic light/dark PNGs; its existing deterministic receipt checkpoint verifies the new bytes.

Required gates: `npm run check`, `npm run build`, `npm run test:desktop:sidebar-overflow`, `npm run evidence:thread-archive`. The full check and adversarial assertion are reported for the exact source in the PR. No tests were retired.
