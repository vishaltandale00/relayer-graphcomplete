# Harness consumption of model-family roles

This contract consumes the agreed family-role decisions through the existing
GraphComplete boundary (PRD FAM-001–006, ADR 0006). The combined PR includes the
authoritative selection/editor PRD and Rust producer as well as this consumer.
Executed integration proof and its limits are recorded in
`docs/evidence/model-family-roles/pr-handoff.md`; the checkpoint names below
identify deterministic production seams rather than a shipping claim.

Execution routes carry `roles: [{ name, description? }]`. Plans with
`schemaVersion: 2` require that field on every route, including an empty array for
unlabelled specialists. Exactly one roster member has the lowercase reserved
`orchestrator` role; the full orchestrator route must agree with that membership.
Names are unique ignoring case, trimmed, and 1–80 Unicode scalar characters.
Descriptions are optional strings of at most 240 Unicode scalar characters.
Each member may have at most 32 roles. Unknown role fields fail closed.

Admission copies and deeply freezes the version, family revision, ordered roster,
roles, and exact root. Role edits invalidate a claimed plan identity. The v2
digest uses `relayer.harness-model-plan.v2\0` and the producer's field order:
`schemaVersion`, `familyId`, `familyRevision`, `orchestrator`, `roster`,
`harnessPolicyDigest`. Routes order `roles` first, then `providerId`, `adapterId`,
`accessContract`, `modelId`, `adapterImplementationVersion`. Roles order `name`,
then optional `description`. Array order is retained. Version 1 means an
absent schema version and absent roles, with its existing JSON field order and
`relayer.harness-model-plan.v1\0` digest. Mixed and unknown versions are rejected.
Historical receipt reading remains product-owned.

Every v2 root and invoked execution receives a JSON roster in its actual native
prompt. User labels remain descriptive data, with Markdown delimiters escaped.
The data includes exact provider-definition, adapter, access-contract, model,
adapter-version, and family identities, and a designated root. It grants no
graph/tool authority and introduces no delegation/review/synthesis policy.

Prime receives selectors identical to its native discovery output:
`relayer-${adapterId}-${base64url(providerId)}/${modelId}`. Its existing native
model scope authorizes the complete admitted roster and isolates request access
by exact native identity. No pinned Prime package changes are needed. Roles do
not appear in native `find_models` output; they appear in the execution prompt.

Codex and Claude receive native model IDs only for members sharing the root's
exact provider definition, adapter, and access contract. Claude subscription IDs
are the native aliases (`sonnet`, `opus`, `fable`); API IDs are passed unchanged.
Other members are marked `metadata-only`, with no cross-provider selector or
credentials supplied to these runtimes. A same-provider selector identifies a
model, but does not by itself establish native specialist launch support. Claude
roles never create SDK agent definitions. Root model configuration remains the
exact admitted orchestrator.

## Checkpoints and verification

| Checkpoint / changed executable seam | Smallest deterministic proof |
| --- | --- |
| V2 normalization, role/version agreement, exactly one root, unknown metadata rejection before access | `host.test.ts`: inconsistent-role rejection journey |
| Admission deep freeze, ordered providers, one lease per exact definition, fixed legacy JSON digest | `host.test.ts`: v1/v2 ordered-family admission journeys |
| Queue captures admitted roles before user mutation while the prior execution is blocked | `host.test.ts`: serialized graph-scope and queued-role journey |
| Producer shape, field-ordered v2 bytes and digest | `host.test.ts`: producer fixture journey; `test/fixtures/model-family-roles-v2.json` has a Python independently computed SHA-256 fixture |
| Role-bearing claim integrity and launch-time invoked admission | `host.test.ts`: family binding and invoked-child admission journeys |
| Prime actual prompt and native scope, root index, selectors, credentials, quiescence | `prime-agent.test.ts`: basic/layered root and invoked role delivery |
| Codex actual app-server turn input, exact root differing from config default, endpoint/key isolation, permissions | `codex-basic.test.ts`: basic/layered root and invoked role delivery |
| Claude actual SDK query input, subscription aliases/API IDs, no agents, key isolation, permissions | `claude-basic.test.ts`: subscription/API root and invoked role delivery |
| New compiled harness module belongs to the sealed shipped telemetry inventory | `test/desktop-telemetry-module-inventory.test.mjs`: exact packaged module inventory |
| Social-preview evidence binds the inventory's exact source identity | `test/desktop-social-preview-evidence.test.mjs`: refreshed source, renderer, and PNG receipt; declared Electron capture runner |
| Continuity, cancellation, accepted/stopped behavior, cleanup | Complete existing host/adapter regression files and required full check portfolio |

Warm entry: `npx vitest run packages/harness-host/test/host.test.ts
packages/harness-host/test/prime-agent.test.ts
packages/harness-host/test/codex-basic.test.ts
packages/harness-host/test/claude-basic.test.ts`.

Required handoff gates: `npm run check` and `npm run build`, including the
declared `test:codex-secret-boundary` process proof. The sealed inventory change
also runs `npm run evidence:telemetry` (PRD §2.5, ADR 0009's authenticated error
reporting portfolio). Because the social-preview receipt binds that inventory,
`npm run evidence:share-preview` refreshes the real light/dark capture and verifies
cancellation, window and server cleanup (SOC-003, ADR 0012). No tests are retired.
The two admission versions protect distinct digest compatibility boundaries;
adapter profile cases protect separate production prompt constructors.

The consumer fixture mirrors the producer's published v2 shape, with `secret@1`
as the existing production access contract. The producer's historical-integrity
goldens use `api-key@1` and different adapter versions; they remain separate
fixtures and do not establish identical cross-language fixture bytes. They test
historical serialization and export/import, rather than native provider access.
Actual production admission and routing are observed by the combined integration
and live trials; see the handoff for exact outcomes.
Deterministic fakes cannot establish task quality, similar spending, arbitrary
native specialist routing, or release readiness. Paid/live proof remains unrun
without explicit authorization; signed/release proof is not due in this scope.

Original consumer-worktree cache preflight: that worktree had no sealed Ladybug/runtime cache directory.
The declared CI bundle workflows are platform-bound; Linux bundles cannot serve
this macOS arm64 build. Local Cargo outputs already exist in the configured
shared target directory, so Cargo revalidates source fingerprints and builds
required sources while every check runs fresh. No cached test outcome is used.
`npm run doctor:dev` passed before native gates.

The first full check found that process fixtures require this worktree's
`target/debug` while the inherited Cargo setting writes to the shared target.
The freshly built, unchanged Rust source snapshot was sealed and verified with
`scripts/ci/runtime-artifact.mjs` before installing its two binaries at that
local path. This also isolates process-test bytes from other worktrees' builds.
The initial missing-path failures are retained in the PR verification record.
Concurrent sibling builds subsequently replaced shared Cargo outputs and caused
four unchanged Rust catalog tests to fail; recompiling this checkout made all
eight catalog tests pass. Final verification uses a private copy of the warm
compiler cache after removing all four workspace crates' outputs, so their
compilation and tests run fresh. A worktree-service test also exceeded its
30-second bound during the broad Vitest run and passed all eight cases alone;
the final full portfolio bounds worker concurrency without omitting tests.
