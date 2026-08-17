# Architecture

## Ownership boundary

Prime Agent is the execution runtime. GraphComplete is the graph algorithm. Relayer is one product host.

```text
Product host
    -> complete(input graph)
        -> Prime Agent root content owner
            -> child content owners
            -> independent self-assess reviewers
            -> targeted revisers
        -> accepted or explicitly stopped graph
    -> product persistence and activation
```

## Required invariants

1. Every scope has one content owner.
2. Every scope is reviewed by a separate self-assess agent.
3. Reviewers search the workspace and do not trust the content owner's claims blindly.
4. A parent judges the coverage and quality it requires from its direct children.
5. Each child owns further decomposition needed within its scope.
6. Concept nodes contain code grounding or connect to descendants that provide it.
7. Existing concepts are connected rather than duplicated when possible.
8. Draft nodes may be visible, but acceptance and unfinished state remain explicit.
9. The graph is terminal only when accepted or stopped with a recorded reason.
10. Budgets limit recursion without converting incomplete work into accepted work.

## Model policy

The initial policy is configurable rather than hard-coded:

- Luna: primary orchestrator and ordinary content ownership.
- Terra: difficult revisions and upgrades.
- Sol: independent self-assessment.

Model and thinking level are separate choices. The runtime must fail clearly when the requested model or effort cannot be provided.

## First implementation slice

Implement one root content owner that can create one child owner, invoke one separate reviewer, and return an explicitly accepted or stopped graph. Use Prime Agent's native child sessions and messaging. Do not build a second agent scheduler.

## Desktop release boundary

Relayer Desktop owns its packaging, signing, notarization, update channels, and product-facing update lifecycle independently of Prime Agent and GraphComplete execution. The production desktop identity is `ai.relayer.desktop`; unsigned development packages use `ai.relayer.desktop.development`. Signed candidates are Apple Silicon builds for macOS 13 or newer and begin at version `0.2.0`.

Release configuration resolves through one fail-closed contract. The contract seals the numeric version, source commit, product identity, Apple team, architecture, minimum macOS version, channel manifest, and exact HTTPS update base into both the application package and its release receipt. The updater and publisher consume this contract rather than maintaining parallel identity or channel rules. See [ADR 0002](decisions/0002-desktop-release-contract.md).
