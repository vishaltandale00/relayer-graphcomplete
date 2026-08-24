# ADR 0006: The product contract is harness and provider agnostic

## Status

Accepted.

## Decision

Relayer product records and workflows use stable provider, model, harness-configuration, permission-profile, project, thread, and interaction identifiers. They do not make Codex, Prime Agent, or another runtime a foundational product concept.

Each thread pins a supported harness configuration and permission profile before its first interaction. Each interaction records its selected model identity. The app server invokes the selected harness through the canonical GraphComplete boundary and accepts only graph-tool writes completed by explicit submission.

The persistent harness host resolves a named configuration to a code-owned implementation factory. The selected harness owns model execution, provider-session reuse, and any internal delegation. A provider adapter owns authentication, model discovery, credentials, and provider-specific execution details. GraphComplete owns graph semantics, interaction-scoped authority, validation, and acceptance. Relayer owns product lifecycle, persistence, activation, and user experience.

Harness configurations declare compatible providers, models, and product permission-profile bindings. Product APIs expose only stable catalog identifiers and normalized receipts. Raw provider credentials, sandbox flags, runtime session records, and implementation-specific recursion policy do not enter the product record contract.

Harness- and provider-agnostic means the product contract remains stable across supported implementations. It does not create a generic agent protocol or make arbitrary providers and harnesses work without explicit adapters, compatibility declarations, tests, and release inclusion.

The packaged application currently includes the `codex.basic` implementation through `codex-basic` and `codex-basic-high`. The `prime.agent` implementation is an optional development and evaluation target until its dependency is consumable in a clean packaged installation. Neither implementation defines the product identity.

## Consequences

- Product requirements and acceptance criteria describe capabilities through the selected harness and provider rather than naming one implementation.
- Implementation-specific setup, limitations, evidence, and tests remain explicit and separately scoped.
- A harness may execute directly or schedule recursive agents internally; GraphComplete does not add a second execution scheduler.
- Adding a supported provider or harness requires an adapter, catalog compatibility, permission translation, lifecycle tests, and product evidence.
- Eval cases remain harness agnostic and may compare supported configurations without changing the underlying product workflow.
- [ADR 0001](0001-prime-agent-runtime-boundary.md) is narrowed to the optional `prime.agent` implementation and is otherwise superseded.
