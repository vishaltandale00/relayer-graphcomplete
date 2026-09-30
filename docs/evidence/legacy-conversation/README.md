# Legacy conversation compatibility evidence

User decision: PRD AGT-011/012, 2026-09-28. This is original-provider containment for conversations whose history exists only natively. Later, #584 (ADR 0014, CONT-004) kept it permanently for legacy conversations; only new continuation conversations are portable. It does not migrate provider homes or copy native state. The user accepted the desktop scenario and subsequently authorized merge. No release or paid inference is included.

## Changed seams and checkpoints

| Checkpoint | Production seam | Deterministic check |
| --- | --- | --- |
| Successful original route survives failed foreign attempts | SQLite root receipt resolver; semantic children excluded | `legacy_conversation_uses_success_receipt_not_failed_foreign_attempt_and_preserves_send` |
| Stale Send cannot change owner or prior text | Atomic ordinary/identified input insert and retry | `legacy_conversation_uses_success_receipt_not_failed_foreign_attempt_and_preserves_send` exercises ordinary Send and explicit foreign retry refusal; `legacy_conversation_excludes_children_and_rejects_changed_adapter_and_attached_send` preserves unconsumed attachment confirmation |
| Catalog/admission race cannot invoke foreign provider | `begin_interaction_attempt`, within its immediate transaction | `legacy_conversation_rejects_foreign_admission_after_successful_owner` |
| Reopen and missing owner do not make foreign routes selectable | Authoritative state/detail projection and model picker | `legacy_conversation_blocks_unknown_and_conflicting_successful_provenance`; independent-connection ownership resolution; `test/model-picker-model.test.mjs` |
| Compatible model changes preserve native conversation | Codex adapter state/identity and root continuity assertion | `codex-basic.test.ts` legacy continuity case |
| Native resume cannot bless a foreign overwritten legacy session | Codex `thread/resume` response checked against trusted accepted interaction input before `turn/start` | `codex-app-server.test.ts` matching/nonmatching native-history scenarios |
| Missing session or changed presentation cannot silently reset | Product continuation assertion passed through trusted runtime/host; all three adapters | Claude/Prime `requireNativeContinuity` regressions (missing history, changed pin, Claude changed storage and mismatched resumed ID); Codex legacy guard regressions |
| Registration preserves legacy pointers | Adapter state serialization or refusal before host persistence | `host-legacy-continuity.test.ts`: real host registration, close/reopen, malformed state refusal without persisted pointer replacement |
| Telemetry recognizes the new application module | Sealed module inventory | `desktop-telemetry-module-inventory.test.mjs` |
| Prime visual continuation survives runtime reopen | Durable fixture-native pointer and prompt history through real host | `prime-visual-integration.test.mjs`, both Prime harnesses |
| Composer input and draft behavior retains its prior guarantees | Real workspace with authoritative compatibility in fake server state | 120 tests across composer traces, authored input traces, Node Details and provider video |
| Useful no-route state and preserved visible history | Production desktop renderer/picker | Real Relayer Dev isolated fixture review; human gate accepted on 2026-09-28 |

No existing boundary is retired. Existing legacy tests that expected an unverified fresh replacement now assert refusal before a replacement session or inference; they still observe the same registration/restoration boundary.

`npm run check` is the deterministic fallback for this new mapping. `npm run build` is required. Desktop review is heavier, performed after the edit loop, with deterministic fixture execution only. Existing `evidence:model-selector` requires live catalog credentials, so it is not suitable for this isolated no-credential gate. The new fixture review uses the real development entry point and product services. It is not live provider proof.

## Accepted desktop scenario

The actual Relayer Dev entry point (`desktop/main/index.mjs`) ran against an isolated profile with deterministic graph execution and inert credentials. The user accepted the displayed result with “ok lgtm” on 2026-09-28:

- The accepted graph and later failed foreign-provider input remain visible.
- The picker offers two original-provider models, with the fixture family named “Codex Basic”.
- The notice reads “Only models from the original provider are available.” in yellow.
- An unavailable original provider preserves readable history and offers reconnect/restore guidance.

Accepted 38-file source digest: `fb0059ee681eb099b6c63fb791229dd12547dded459e68632c60758fef05e031`, on base `c6813890b2fc3f5c0cb2807f3ce509ef31673931`, committed as `b6895b05`. The digest is SHA-256 over sorted UTF8 relative path + NUL + raw SHA-256 file bytes. Local fixture identity, screenshots, source manifest, logs and the explicit acceptance receipt remain in `.relayer/legacy-compatibility-evidence/`. This desktop acceptance does not claim live provider continuity. Light-theme tokens were source-reviewed; the displayed scenario used the dark theme.

## Verification before integration

Plan: focused ownership/admission, adapter restoration, renderer, fixture and telemetry checks; then complete `npm run check`, `npm run build`, desktop review, and adversarial review.

Actual: the final accepted source passed the complete unfiltered `npm run check` using pinned Node 22.23.2, `RUST_TEST_THREADS=1`, `CARGO_BUILD_JOBS=2`, and a verified Ladybug bundle. It also passed `npm run build`, 37 picker tests and PRD readability. Full Vitest reported 3030 passing and three existing skips. No new filter or skip was added. Earlier disk exhaustion, Git deadline and Node 26 permission failures are retained in local logs and superseded by this complete successful run.

Reviewer `/root/compatibility_review` found no actionable issue or mapping gap at the accepted digest, covering ownership, Send/retry/admission, picker, native restoration, state preservation, fixture fidelity, telemetry inventory and PRD. The later integration changes invalidate that review for the combined source; the PR must record its replacement assertion.

## Integration with main

Main now includes #571 (native root lifecycle) and #569 (default-model recovery). Integration preserves their behavior while applying the explicit AGT-012 exception: required native continuity refuses fresh-session fallback. Non-required continuation retains reset diagnostics and lifecycle handling. Legacy picker recovery takes precedence over unrelated default-family setup; unrestricted conversations retain #569 recovery. The Prime fixture supplies both durable native history and the presentation resource loader.

Additional checkpoints: native lifecycle and legacy continuity adapter scenarios, default-family recovery plus restricted legacy picker regression, full deterministic check/build, and adversarial review of the combined source. Results and the exact reviewed snapshot are recorded in the PR after those checks finish. Prior human acceptance remains scoped to the displayed policy and notice; it is not relabeled as proof of the merged native lifecycle.

Final integrated verification: complete `npm run check` and `npm run build` both exited 0 on 2026-09-28 under pinned Node 22.23.2. Broad Vitest: 3137 passed, three built-in skips; secret-boundary: two passed. Source digest `c0bba211c7a31b7899799fc13bec5949d1ab54a3003ff8c732ecc23ac62fa04a` covers the 41 changed source/test/PRD/driver files relative to main, excluding this README, and was reverified after the run. Local logs: `/tmp/p0-integrated-check.log`, `/tmp/p0-integrated-build.log`. Native reviewer reported 320 focused passes and no unresolved findings; UI reviewer reported 61 focused passes and no unresolved findings after correcting original-provider recovery. Exact scoped review assertions are recorded in the PR.
