# ADR 0004: Permission profiles are a Rust-owned product contract

Status: accepted

## Decision

Relayer exposes exactly three base permission profiles: `ask` (Ask for approval), `auto` (Approve for me), and `full` (Full access). The Rust product policy catalog owns their IDs, labels, enabled set, default, and authority semantics. A named harness configuration supplies an implementation-specific binding for each profile it supports; those bindings are not the product API.

A product thread pins both its harness configuration and permission profile before its first interaction can run. Every interaction inherits the thread profile. Accepted interactions persist the harness snapshot digest, a digest of the harness-plus-profile execution identity, and a normalized permission receipt. The receipt records product semantics but does not expose raw provider flags or credentials.

The `codex.basic` binding translates `ask` and `auto` to bounded workspace access with user or automatic approval review, respectively. `full` translates to unrestricted Codex access without approvals. Because Full access is not a hard filesystem or network boundary, its receipt and Eval artifacts must disclose that fact.

Relayer Eval selects these same product profiles through the ordinary thread API. The H3 project case uses `ask` for architecture, `auto` for diagnosis, and `full` for implementation. Read-only task prompts and unchanged-workspace grading remain acceptance constraints, not hidden permission profiles. Simulated-user judges retain their separate read-only review authority.

An internal Eval matrix may explicitly substitute `full` for an H3 thread's requested profile only when the selected development harness exposes `full` as its sole binding and the fixture is disposable. The run records the requested profile, effective profile, unrestricted authority, and override reason. This compatibility resolution happens before thread creation; it does not silently change a product thread's pinned authority.

## Consequences

- Product code, Eval cases, and harnesses share stable profile IDs instead of exchanging raw provider flags.
- Desktop policy may disable a base profile, and a harness may omit a binding. Selection fails with a typed error before inference starts.
- The sole-Full H3 Eval exception is explicit, recorded, and unavailable to ordinary product selection.
- A thread cannot silently change permission authority between turns or after restart.
- Harness implementations may translate profiles differently, but cannot add a fourth base product profile.
- Full access is useful for Git-writing implementation work, but outer process isolation is required when hard confinement matters.
