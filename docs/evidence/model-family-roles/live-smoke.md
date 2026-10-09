# Combined family-role harness trial — 2026-10-08

This local trial combines product producer `6bd48c58cac50b0be2aa9a1d36c9db82916b0be5`,
the consumer patch from `4cefc2643b8119f1d854841dd0eff41e4dbc18ca`, and the approved
compact roster picker changes. It is an execution smoke test, not release or
quality/cost qualification. No scheduler or new native agent definitions were added.

## Required verification plan

The consumer checkpoint map is in `docs/contracts/harness-model-family-roles.md`.
The changed seams are V2 plan normalization/admission/freezing, native model-family
prompt construction for Prime/Codex/Claude, and the sealed telemetry inventory.
The product producer supplies roles and the next-turn plan; the picker supplies
the family selection and visible member roles.

Required deterministic gates are the four host/adapter files, `npm run check`,
`npm run build`, `npm run evidence:telemetry`, and `npm run evidence:share-preview`.
The live checkpoint additionally observes the actual product send, native root
and child turn contexts, and product-owned graph acceptance. Paid inference was
explicitly requested by the user and is absent from the default suite.

## Observed live evidence

The isolated desktop profile has only a compatible Codex connection. Through the
actual Settings UI, family **Codex role smoke test**, revision 2, was configured:

| Member | Role |
| --- | --- |
| `gpt-6-luna` | `orchestrator` |
| `gpt-6.1-sol` | `implementation` |
| `gpt-6-astra` | `review` |

One synthetic JavaScript task explicitly requested both specialist models. The
root's actual native prompt contained the exact role-bearing roster and
descriptions. Native child turn contexts identify Sol and Astra, with both
parent IDs equal to the Luna session. Product SQLite records interaction 1,
attempt 2 as **accepted**, effect boundary **graph_write**, using the matching
admitted V2 plan and admission `c04821fe-310a-44cf-90c3-0954d8d77656`.

Private local artifacts under `.relayer/evidence/family-roster-picker/harness-live/`:

- `codex-smoke.json`: admitted plan, acceptance, three original rollout SHA-256s,
  native model/parent identities, requested spawns, token usage, safe final outputs.
- `codex-smoke.png`: accepted graph visible in the desktop preview.
- `source.json`: base plus 17 changed source/test/contract files; canonical digest
  `35c6da6036126679304d43ee7f315c7407f87981a1528d278f96480b22d5f1a8`.
  Canonical bytes are sorted relative path, NUL, file bytes, NUL. Generated
  receipts and this evidence note are outside that implementation identity.
- `build-provenance.json`: exact package links/resolution and compiled hashes
  captured **after** the smoke and full build. These are not retroactive proof
  of every pre-launch build byte.

Attempt 1 failed before admission/inference (`model_failed`, boundary `none`).
The worktree's inherited top-level dependency symlink resolved the producer's
older V1 harness package. Replacing only this worktree's dependency layout with
private `@relayer` links to its own packages fixed resolution; attempt 2 is the
one actual live model run. The producer checkout was not modified.

Both specialists correctly identified the `NaN` problem and recommended
`const unique = xs => [...new Set(xs)]`. The synthesized graph node incorrectly
says the original filter "keeps every occurrence" of `NaN`; it actually removes
all `NaN` values because `indexOf(NaN)` is `-1`. This is a model-output quality
finding, despite successful routing and graph acceptance. No quality pass is claimed.

The trial establishes requested same-provider native routing and accepted
completion. It does not establish autonomous specialist selection, arbitrary
cross-provider native routing, quality parity, or comparable dollar spending.
Per-session input/cache/output usage is retained without a dollar-cost claim.
Prime requires a compatible API provider and Claude requires Anthropic API or
Claude subscription. Neither was run live in this profile.

## Actual deterministic execution

- Focused host/Prime/Codex/Claude regression: **292/292 passed**, four files.
- Package build and full `npm run build`: **passed** using this worktree's
  isolated, previously verified native cache and private Cargo target.
- First-message deterministic integration: **2 passed, 1 timed out** initially.
  The unchanged timed-out case passed on a selected-case rerun (**1 passed,
  2 skipped**). Concurrent compilation was observed; its causality is unproven.
- Telemetry heavy entry: **5 Rust and 183 portfolio tests passed**; local-only
  privacy evidence verdict is `local-gateway-privacy-pass-release-indeterminate`.
  The artifact records 10 positive gateway requests, 176 rejected privacy cases,
  and 99 adapter privacy cases.
  No live Sentry/Auth0 or release-symbol proof was run.
- Social capture heavy entry: **passed**, actual light/dark PNGs and refreshed
  receipt, cancellation and window/server cleanup passed.
- Receipt and sealed module inventory: **2/2 passed** after refreshing capture.
- Full `npm run check`: **failed** in Rust
  `environment::tests::command_runner_enforces_start_timeout_and_output_bounds`
  (363 passed, 1 failed); its output-size assertion failed within a one-second
  bound. The unchanged exact case **passed** alone on rerun. The full command
  stopped before the remaining portfolio, including the secret-boundary process
  proof. Those downstream gates remain unrun for this combined snapshot. This
  is not a full-check pass and no merge/release readiness is claimed.

## Adversarial review

Reviewer `/root/roster_picker_review` independently checked original rollout
hashes, native root/child model contexts and parentage, model-visible roster,
and read-only product SQLite acceptance/admission. Verdict: evidence supports
one successful live Codex smoke. The reviewed smoke artifact SHA-256 is
`beb40e610b8b29d144220c0e8199cfd8aef21c807a9305c080d10aa8f3217fc0`.
The reviewer additionally verified all 17 declared source hashes, 96 compiled
hashes, and four `@relayer` package resolutions. `source.json` SHA-256 is
`d37103b5b6c7e5319fedb5053b7b7307a2cff175c42e3024d1da8f17d7c26c2a`;
`build-provenance.json` SHA-256 is
`76245342d55bee6619fa7dae9784c2723f7bf6cc69b05491b333e2b8d26ac525`.
Read-only graph inspection confirmed the synthesis error in node 23's authored
`main` component. Verdict: bounded execution evidence valid; quality defect
remains. Deterministic suites were not independently rerun by the reviewer. Complete
pre-launch build-byte provenance was not retained. This is a **non-certifying
handoff review**, with no new PR or release qualification claim.
