# Agent instructions

Read `README.md`, `docs/architecture.md`, and the applicable architecture decisions before changing behavior.

- Prime Agent owns recursive agent execution; do not add a second scheduler.
- GraphComplete owns graph semantics, scope, self-assessment, and acceptance.
- Keep `complete(inputGraph)` as the canonical external boundary.
- A model turn ending is not graph completion.
- Preserve explicit draft, accepted, and stopped states.
- Use deterministic rules for integrity and authority, not as substitutes for model judgment.
- Do not use paid inference in the default test suite.
- Run `npm run check` and `npm run build` before committing.

