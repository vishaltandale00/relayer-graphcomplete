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

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the canonical five-role label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a multi-context repository. Read `CONTEXT-MAP.md` and the relevant context documents when they exist. See `docs/agents/domain.md`.
