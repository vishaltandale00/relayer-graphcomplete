# Domain docs

This is a multi-context repository. Engineering skills should use the root context map to find the domain documentation relevant to the area being explored.

## Before exploring

1. Read `CONTEXT-MAP.md` at the repository root when it exists.
2. Follow it to each `CONTEXT.md` relevant to the requested work.
3. Read applicable system-wide decisions under `docs/decisions/`.
4. Read any context-scoped decisions referenced by the relevant context document.

If a context file does not exist, proceed silently. Do not create empty domain documentation upfront. The `domain-modeling` skill creates or updates it when real terminology or decisions are resolved.

## Intended contexts

The context map may route among these architectural ownership areas:

- **Graph completion**: graph semantics, authority, validation, persistence, clients, submission, and acceptance.
- **Harness runtime**: persistent harness sessions, provider execution, model-family resolution, recursion, permissions translation, and cancellation.
- **Product host**: Relayer application state, app-server lifecycle, Electron ownership, desktop UX, and provider setup.
- **Evaluation**: test cases, harness matrices, judges, imported artifacts, evidence, and read-only review.

Package boundaries are implementation boundaries, not automatically separate domain contexts. A context may cover multiple Rust crates, Node packages, Python clients, or desktop directories.

## Use the glossary’s vocabulary

When output names a domain concept—in an issue title, design, hypothesis, test, or implementation—use the term defined in the relevant `CONTEXT.md`.

If the concept is absent, reconsider whether existing terminology already covers it. If it is genuinely new, note the gap for `domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an accepted decision under `docs/decisions/`, surface the conflict explicitly rather than silently overriding it.
