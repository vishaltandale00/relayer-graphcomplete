# Upgrade recovery and artifact release journeys

This change implements the October 19 decision to catch failures in existing
profiles and full user journeys. PRD PROV-011, PROV-009 and ART-006 define the
promises; ADR 0006 preserves provider/runtime ownership, and ADR 0014 preserves
artifact-layer activation. Plain URLs do not become artifact layers.

## Changed seams and checkpoints

| Executable seam | Checkpoint and deterministic observation |
| --- | --- |
| Production readiness coordinator | PROV-011: completed checks enqueue independent commits while Prime is pending. Shared recipes still prepare once. Existing tests retain latest-generation, current-route and backend revocation fences. New adversarial tests drain siblings after publication failure and preserve newer progress ownership. |
| Post-upgrade lifecycle | PROV-009/011: production startup helper evaluates due Codex, Claude and Prime routes. Healthy commits clear only their own fixture due marks. Cancellation hides progress immediately and refuses late commits. Existing Rust catalog tests retain actual due persistence, migration and reopen proof. |
| Main-process progress and provider status projection | PROV-011: progress is a transient presentation flag forwarded by the real definition service, separate from persisted connection and readiness authority. Main/preload/renderer wiring remains in model-availability-refresh tests. Failed publication cannot leave a finished evaluation showing Preparing. |
| Provider status, onboarding and Sign out markup | PROV-011: the combined readiness/definition-service/renderer scenario shows Preparing only with an active owner, preserves Sign out, admits healthy subscriptions, and exposes Repair after failure. Pending without an active owner still exposes Repair. Existing provider UI tests cover connection/model setup precedence. Harnesses retains its explicit repair escape. |
| Actual onboarding options and family step | PROV-011: `model-family-onboarding.test.mjs` drives the real auth entry point through production progress notifications. Pending setup shows Preparing and blocks Finish; readiness restores choices; terminal failure exposes Repair. Empty pending projections preserve family drafts, members, roles, focus and caret. Background refresh never completes defaults. Deferred status and projection replies are separate boundaries: neither can reopen a family step after Back or replace a typed credential form. The model-availability wiring checkpoint binds this refresh to the production callback. |
| Artifact evidence runner | ART-006: deterministic fixture uses actual graph-client writes and acceptance. The clicked accepted action must resolve to the exact artifact layer/node displayed. Return restores the graph; saved-thread renderer reload and reopen retain identities without a new execution. Existing renderer and provenance tests cover the reused production modules. |

No tests are deleted. The former batch-publication assertion now checks the
same exact successful/failed rows as separate commits. Existing stale-route,
shared-recipe and generation tests protect distinct authority boundaries;
they are retained alongside the new independent-progress scenario.

## Required verification plan

Run focused readiness, provider and availability tests during editing. Before
handoff run `npm run check`, `npm run build`, and the declared heavy entry point
`npm run test:desktop:artifact-viewer`, under the repository's pinned Node 22.
The conservative deterministic fallback is the full check: this change adds no
narrow verification portfolio. Reuse compatible native build outputs under the
CI cache contract; no inference is needed for these checks.

Renderer and main-process edits also invalidate the desktop-social-preview
receipt. Its existing evidence contract requires `npm run evidence:share-preview`,
visual inspection of both captures, and the receipt/hash checkpoint. Regenerate
the captured evidence rather than updating hashes without a capture.

The artifact runner writes ignored local evidence to
`.relayer/evidence/artifact-viewer/results.json`, screenshots and video. Its
workspace provenance binds the tested tracked/untracked source; results list
each inner assertion and explicit limits. Command completion alone is not a
pass. Final handoff must report actual results separately from this plan and
record any adversarial review against that exact source digest. Without a PR,
that review is non-certifying.

## Release-only evidence

The release runbook now requires operator qualification of the exact signed
candidate over a private, versioned prior-release profile with dedicated
connected subscription test accounts, families, chats and an accepted artifact.
It includes interruption/relaunch and the saved artifact journey. It precedes
the Preview tag; the real updater canary still follows publication. These are
operator gates, not automated publisher enforcement. No candidate qualification
or publication is performed by this implementation change.

The separately authorized live authoring smoke remains outside default tests.
Fixture authoring proves graph routing, not whether a real model chooses to
author an artifact. Native process restart, connected-account readiness and
live inference are not inferred from the fixture's renderer reload.
