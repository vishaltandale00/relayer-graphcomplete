# Agent instructions

Read `README.md`, `docs/architecture.md`, and the applicable architecture decisions before changing behavior.

- Each harness provider owns its native recursive agent execution. Prime Agent and Codex may use their own native recursion; do not add a GraphComplete or harness-level scheduler.
- GraphComplete owns graph semantics, scope, self-assessment, and acceptance.
- Keep `complete(inputGraph)` as the canonical external boundary.
- A model turn ending is not graph completion.
- Preserve explicit draft, accepted, and stopped states.
- Use deterministic rules for integrity and authority, not as substitutes for model judgment.
- Do not use paid inference in the default test suite.
- Run `npm run check` and `npm run build` before committing.

## Change verification workflow

For every implementation change:

1. Treat `docs/prd/index.html` as the authority for product meaning. Read the relevant PRD sections and decisions, then list every changed executable seam, including secondary behavior in mixed-purpose changes. If the intended behavior is missing or ambiguous, surface the product decision; update the PRD only from an explicit decision and withhold the proof claim until then.
2. Turn each affected product promise, failure boundary, and authority boundary into an explicit checkpoint. Map every checkpoint to the smallest deterministic test that observes the real production seam; prefer realistic fixtures over duplicated setup or assertion-heavy micro-tests.
3. Keep the edit loop warm. Run the relevant in-process tests while coding, targeting ten seconds or less. In-process migration, reopen, persistence, and realistic multi-step scenarios belong here when they meet that budget. Do not run Electron, external-runtime, process/app-restart, packaged-app, release, or paid-inference proof after every edit.
4. Remove test bloat deliberately. Keep overlapping tests only when they protect distinct failure boundaries, and state that distinction. Retire a test only after its replacement passes, observes the same boundary, and survives adversarial subsumption review.
5. Do not narrow verification when a checkpoint or changed seam is unmapped. Name the exact mapping gap and run `npm run check` as the deterministic fallback until a versioned portfolio replaces it. When product meaning is explicit, repair and adversarially review the mapping in the same change. Otherwise report the change as blocked on a product decision; do not invent a checkpoint. An unmapped change never means “run nothing.”
6. Before handoff, run the applicable deterministic heavy entry points named by the PRD, evidence README, or package scripts. When an existing runner supports it, batch compatible checks into one invocation while keeping chapter results and reset failures independently visible. An undefined heavy entry point remains indeterminate; do not improvise proof. Run paid, live, signed, release, or unavailable-platform proof only in its declared context and with required authorization. Release-candidate proof is due only in Preview or Stable release context.
7. Use adversarial subagents for applicable consequence-bearing dimensions, especially ambiguous mappings, semantic/UX/authority claims, heavy evidence, and test deletion or subsumption. Agent transcripts are not durable evidence. Record a compact assertion in the PR: reviewer, exact commit or workspace digest, reviewed scope, verdict, and unresolved findings. Invalidate it when that source state changes. Without a PR, report the review as non-certifying in the handoff.
8. Report the required verification plan, what actually ran, and the resulting evidence separately. Claim a pass only for the exact tested source snapshot; a planned test, test name, or outer command exit code is not proof that an inner scenario passed. Preserve failures and unknowns explicitly.

## Desktop releases

Follow `docs/desktop-release-operations.md`. Reuse proof from the exact commit instead of repeating completed release steps. Diagnose a failed release before retrying, and allow at most one unchanged retry for a confirmed flaky or infrastructure failure. Never move or recreate a release tag. Report when validation, notarization, publication, or verification is causing a delay.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the canonical five-role label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a multi-context repository. Read `CONTEXT-MAP.md` and the relevant context documents when they exist. See `docs/agents/domain.md`.
