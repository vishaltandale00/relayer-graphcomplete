# Model-family roles: product verification portfolio

Authority: PRD FAM-001–006 and ADR 0006, model-family execution authority (2026-10-07).
This portfolio covers the Rust product producer and renderer. The companion harness
consumer owns role visibility in Prime, Codex and Claude. Consumer integration,
arbitrary cross-provider native specialist routing, quality, and spend are separate
claims. No live or paid inference belongs to this portfolio.

## Changed seams and checkpoints

| Checkpoint | Production seam | Deterministic observation |
| --- | --- | --- |
| FAM-001 family-only requests resolve current orchestrator, stale model fields cannot override it | thread creation, normal/context-bearing Send, retry, semantic child launch | `product_model_selection_is_validated_inherited_transported_and_auditable`; `family_roles_save_reopen_future_root_and_child_use_designated_orchestrator`; interaction/context retry and idempotency suites |
| FAM-001 composers expose families, preserve pinned harness, close/focus after commit | picker normalization, new and ongoing DOM, request payload | `model-picker-model`, `model-picker-ui`, `default-family-recovery` Vitest suites |
| FAM-002 roles persist on exact membership; one orchestrator; multiple labels and descriptions; invalid/duplicate names refused | API member conversion, family validation, SQL replacement/loading, Settings editor | roles save/reopen root-and-child scenario; `model-family-settings-refresh` real DOM save/reopen; catalog API fixtures and family validation |
| FAM-003 explicit custom choice; managed labels follow preference/order; availability never elects another member | managed policy derivation/refresh, copy/create UI | `managed_refresh_keeps_unavailable_orchestrator_and_family_only_requests_refuse`; `managed_api_and_router_refresh_retains_unavailable_or_missing_orchestrator`; Settings suites |
| FAM-002/003 custom onboarding requires a chosen orchestrator; switching and removing members preserves the exact role boundary | auth membership/radio handlers, completion intent, onboarding API | `model-family-onboarding` real DOM sequence and `provider-onboarding-model` / `provider-ui` suites |
| FAM-001 Eval matrix and Human Grader follow-ups send only the selected family; starting harness/family authority and budget persist | Eval request conversion, profile revalidation, Human Grader validation/Send/retry proxy | `eval-service-simulated-user`, `eval-service-human-model`, `eval-service-live-authorization`, `eval-human-task`; real browser Human Grader chapter |
| Consent: subscription-only Human Grader revalidates the retained family adapter before opening, Send and retry; same-family subscription model changes remain allowed | live credential route resolver, Eval pre-dispatch guard, Human Grader reservation boundary | `eval-service-live-authorization` subscription-to-API scenario; `eval-human-task` create/next-step/Send/retry no-dispatch and no-budget-spend scenarios plus typed pre-dispatch refusal refunds before and after reservation and during grading; production credential resolver suite |
| Consent: concurrent family edit cannot cross subscription-only root authority; constraint survives reopen and semantic children share it | root request conversion/idempotent creation, immutable thread constraint migration, atomic attempt admission | `subscription_authority_refuses_family_change_between_validation_and_creation` through real product API; `persisted_subscription_constraint_rejects_current_api_plan_at_atomic_admission` reopen/refusal/authorized admission; Eval request assertion |
| FAM-001/005 programmatic Prime profiles explicitly designate their first model and validate one family route | `desktop/eval-main/prime-provider.mjs`, `provider-setup.mjs` | `eval-prime-provider` and `eval-provider-setup` suites, role-inclusive profile mismatch refusal |
| FAM-003 schema upgrade is repeatable, preserves default, order, historical model identity and revision | migration 0043 and reopen | `schema_42_roles_backfill_family_order_without_rewriting_history` |
| FAM-004 unavailable/denied orchestrator refuses; specialists filter independently | plan resolver, harness usability, onboarding choices, provider-removal guard | `model_plan_preserves_resolvable_family_order_and_requires_the_orchestrator`; managed-refresh API scenario; `onboarding_and_usability_never_substitute_an_available_specialist`; catalog/provider-removal tests |
| FAM-004 recovery reaches affected family; requested harness is used; absent models are unavailable | family setup/picker availability, Settings recovery DOM | unavailable/requested-harness picker scenarios; Settings role-edit/recovery DOM scenario including compatible harness choice; provider recovery suite |
| FAM-005 preparation/admission revision race refuses; roles and exact identities compare; post-admission edit leaves snapshot unchanged | atomic attempt admission, interaction identity write, runtime response validation | `attempt_admission_rejects_family_revision_race_and_freezes_the_admitted_plan`; roles root/child scenario with altered signed roles; stale-harness-policy test |
| FAM-005 V1 bytes/digest remain readable; V2 binds roles; unknown/mixed versions, null roles/descriptions and duplicates fail closed | runtime digest, portable export validation, export-service conversion, import decode | golden fixtures `admitted-plan-v1.json` and `admitted-plan-v2.json`; `family_role_fixtures_bind_versions_and_exact_roles`; `role_bearing_and_historical_plans_roundtrip_with_versioned_integrity`; export/import suites |
| Secondary capture fixtures follow family-only UI and explicit onboarding orchestrator; refreshed social-preview receipt binds changed renderer bytes | provider video capture selectors/fixtures, existing preview renderer artifact manifest | `provider-electron-evidence` full and focused capture scenarios; `evidence:share-preview`, `desktop-social-preview-evidence` |
| Authority: native conversation ownership still restricts provider/harness histories; failures preserve draft/context; roles cannot add graph/tool authority | existing conversation compatibility, retry/context transactions, unchanged permission/graph seams | legacy-conversation tests, retry/idempotent context suites and complete workspace checks |
| FAM-006 producer emits role-bearing plans; consumer exposure remains companion scope | execution/admitted JSON field ordering and versioned digest | shared raw fixtures and Rust golden parity; integrated consumer proof required separately |

The portfolio deliberately retains distinct boundaries: migration/reopen, SQL admission
race, API transport, renderer recovery/focus, and portable integrity are separate tests.
No test was retired. Historical per-model-selection assertions were updated to explicit
family designation; model/provider failure and native-history authority boundaries remain.
The larger transport scenario changes the family through the production API before each
failure/retry route, rather than accepting an individual-model override.

## Required plan

Warm loop: focused role/migration/admission tests and the five renderer suites.
Before handoff: `npm run check` (full deterministic fallback until this portfolio has
adversarial approval) and `npm run build`. The deterministic heavy entry point is
`npm run test:eval-web`: real Chromium, product API, Settings save/reload and process
reopen, with fixture execution. It requires the companion V2 harness consumer.
Existing `evidence:model-selector` captures live model discovery and historical
individual-model screenshots; it is not proof of these replacement promises.
Release-candidate, signed, packaged and paid/live proof is outside this draft-PR context.

## Actual runs and evidence

Source identity: `implementation-snapshot.json`, base
`c2905c193c98529bfcda8891f8a0ada8e2dbc213`, digest
`sha256:4f4cd644a3a9b285aeb3aa4dc60ce30a6bfbbde296eb75ce9e602c57390de234`.
The manifest binds all 81 changed implementation, style, test and fixture files;
unchanged source remains at the base commit. Documentation and generated captures
are excluded from the digest to avoid self-reference.

| Entry point | Actual result | Claim and limits |
| --- | --- | --- |
| `cargo test -p relayer-app-server subscription_` | PASS, two scenarios | Real API validation/edit/creation refusal, authorized idempotent replay and changed-constraint conflict; persisted atomic admission after reopen, explicit semantic-child refusal and authorized root admission. No inference. |
| Focused Eval authorization, Human Task and production credential resolver suites | PASS, 88 tests in 6.53 seconds | Subscription root/next-step HTTP 422 refunds and rolls back; HTTP 500/transport retain reserved authority and lock unknown dispatch. Existing Send/retry guards, family retention and late-refusal boundaries remain covered. |
| `npm run check` | FAIL (exit 1) | Formatting, Clippy, Rust workspace/crash reconciliation, native/package builds, TypeScript and workspace checks PASS. Vitest: 291 files / 3,728 tests PASS; 9 files / 26 tests FAIL; 1 file / 3 tests skipped. The failure prevents automatic execution of later gates; those were run separately. |
| `npm run build` | PASS (exit 0) | Native product/graph build, TypeScript distribution and all four workspace package builds. Run sequentially after the check. |
| `npm run test:eval-web` | FAIL (exit 1) | Startup cleanup, real lifecycle/export/restart/read-only authority, host tabs/trace/restart, and production Settings provider/family/harness save/reload chapters PASS. Shared dashboard execution completion timed out with an execution still running and no turns. Later Human Grader/Task Actor chapters were UNREACHED; no whole-run pass. |
| Remaining check gates after the Vitest failure | PASS | Secret process boundary 2/2; Python 68/68; Ladybug qualification/native/contract receipt lints. PRD readability PASS after final documentation. |
| Renderer/Eval warm portfolio before the final Rust/consent-only edits | PASS, 170/170 | Intermediate warm-loop result only; the final full Vitest run controls current-source claims. |
| Existing provider/social capture tests and social preview | PASS, 6/6; `evidence:share-preview` PASS | Full/focused provider fixture captures and refreshed light/dark preview. Preview receipt binds current renderer bytes; both images visually inspected. The final consent edits do not change those renderer bytes. |

The nine failed Vitest suites are `attached-portability-e2e`,
`conversation-export-eval-e2e`, `eval-app-integration`,
`first-message-composer-integration`, `graph-program-patch-rerun-e2e`,
`marine-icon-integration`, `prime-visual-integration`, `recursive-complete-e2e`,
and `stop-run-integration`. Observed attempts fail before admission
(`attemptAdmissionId`/`admittedPlan` absent), or tests time out waiting for running
or accepted work. Source inspection confirms the unchanged base host normalizes
routes without roles and signs `relayer.harness-model-plan.v1`; this product emits
V2. The companion consumer is therefore the identified integration prerequisite;
this slice does not claim those scenarios passed or that no other integration
failure can remain after composition.

Intermediate failures were diagnosed, not counted as proof: shared Cargo output
was overwritten by another worktree; hardcoded target paths required an isolated
local target link; Node 24 and overlapping package compilation disrupted browser
imports; old role-less/per-model fixtures were corrected. New consent fixtures
initially omitted provider timestamp/harness details and assumed an empty seeded
database or a nested error response; corrected scenarios passed. These were
fixture/build-environment failures. Integration failure against the V1 consumer
remains a separate unresolved result.

## Adversarial assertion

Reviewer `review_product_contract` verified all 81 manifest hashes for
`sha256:4f4cd644a3a9b285aeb3aa4dc60ce30a6bfbbde296eb75ce9e602c57390de234`.
Verdict: PASS for product-producer source and checkpoint mapping; no unresolved
findings in reviewed scope. Scope: family/role semantics, managed retention,
historical native ownership, atomic subscription authority, reopen, constrained
creation idempotency, semantic-child inheritance, and refusal/budget handling.
The reviewer did not independently rerun tests. This assertion does not certify
consumer integration, heavy end-to-end completion, paid quality or spending.
The draft PR records this source assertion; it is not a substitute for the scenario results above.

## Build-cache provenance

The main CI run inspected had no native bundle. A trusted local Ladybug build was
sealed and verified with repository `scripts/ci/lbug-artifact.mjs`, source commit
`649e06982307f4407c808ce7a4a8bafdf71ab8b0`, macOS ARM64, rustc 1.98.0, lbug 0.18.
Artifact directory: `/Volumes/2T-SSD/relayer-build-cache/model-family-ladybug`.
Verification checked the manifest identity and SHA-256 (`02a76a5ea8d1…` native library).
Compatible Cargo dependency outputs were cloned to an isolated target directory;
first-party product/graph artifacts were cleaned before verification because concurrent
worktrees overwrote shared first-party outputs. Cached output never replaces tests.
