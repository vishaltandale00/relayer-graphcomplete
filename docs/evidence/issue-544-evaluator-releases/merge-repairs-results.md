# PR #671 review repair verification

The adjacent README maps every repaired executable seam and boundary. Required plan: focused production-seam tests, build, full check, compiled-runtime proof, full browser runner and adversarial authority/storage/UX review. No tests were deleted. Repairs preserve existing product meaning; no new stopping rules, default selection or grading authority was added.

## Actual final results

- Focused four-file suite: 109 tests passed in 2.31 seconds.
- `npm run build`: passed.
- `npm run check`: passed; 3,581 Vitest tests (three skipped), two secret-boundary tests, 68 Python tests, Rust formatting/clippy/tests/crash reconciliation, package/type checks, receipts and PRD readability.
- `npm run test:eval-compiled-runtime`: four scenarios passed in 13.54 seconds.
- `npm run test:eval-web`: all chapters passed after prerequisite stabilization, including independent completion selection with exact form/export pins, release locking, catalog refresh while pinned, restoration of the historical blank fallback, calibration, structured actor input and native product restart.
- `git diff --check`: passed.

Final executable/fixture scope SHA256: `967d7e65ceb938bc1f33b6e39046931c26967f4daba4f19784099bb92f279664`. Algorithm: sorted relative UTF8 path + NUL + bytes + NUL. Scope:

- `desktop/eval-main/completion-git-view.mjs`
- `desktop/eval-main/eval-service.mjs`
- `desktop/eval-main/human-task-service.mjs`
- `desktop/eval-main/task-completion-artifacts-v2.mjs`
- `desktop/eval-renderer/human-tasks.js`
- `desktop/eval-renderer/index.html`
- `scripts/test-eval-web.mjs`
- `test/eval-setup-registry.test.mjs`
- `test/eval-task-actor.test.mjs`
- `test/eval-task-completion-artifacts.test.mjs`

Three refreshed adversarial assertions are in `merge-repairs-review.json`; no unresolved findings in their scopes. Their exact digests will be recorded on the PR with the repair commit. Reviewers ran no gates. Earlier assertions remain historical and are superseded for changed files.

## Preserved failures and unknowns

The portable-resolver regression initially failed because a macOS alias hid that an executable was inside the candidate workspace; canonicalizing the workspace repaired it. An initial full check failed three unchanged Rust visual-assets-host startup tests while a concurrent build cleaned compiled package outputs. The later sequenced check passed all of them. A browser attempt then failed at startup with missing compiled graph-client output; its precise interference source was not independently established. After full package checks settled, one sequential browser run passed every chapter. These failures are retained, not counted as successful proof.

Native Windows Git/junction execution is unavailable-platform proof; deterministic resolver coverage simulates Windows executable naming and exclusion. No new live inference ran during repairs. The earlier three-case fresh-model results remain evidence for source d418e78e only, not this repaired snapshot.

Raw logs remain locally under ignored `.relayer/evaluator-merge-repairs-2026-10-05/`.

| Log | SHA256 |
| --- | --- |
| warm2 | `596d3c0cb32bdb47f0e06914fb1cb3f55da87426d7efe9b40e4f9ef87eec6392` |
| warm4 | `d7ecc6ed63ceeac7678d6c2022f9ff25474541bcd422529bcc26c6752fe617f6` |
| build-final | `4cbf109709fcd7989734f13bce575b8e8b7f30ac425798a62711da8dee532b48` |
| check | `52f7bdf96d95a1af46b9ec581cbeeca03e875245dff96c0ec0f1f704bc3cb4bf` |
| check-final | `c88f3f3277406d52f82a56c7553620c4186edfe8f52e8b791f48234f0f986b88` |
| compiled-final | `3895929d8055bcbee63f40204fa73b335aef558078428322061882d2735cfa7b` |
| browser-final | `a042e5725fff17b727dddf64d0b5dae8f6004a9cd19225c13d1fc15d0526bfd5` |
| browser-sequential | `f746713839c90f903bee8390c7fff5033a8fc46ded8d0e5c98bc4f4953e7c3eb` |
