# ADR 0002: Start the Relayer app server as a product persistence skeleton

Status: accepted

## Decision

The first Relayer app-server slice is a Rust process tied to the Electron desktop lifecycle. It owns durable local records for projects, threads, and product interaction chronology in SQLite and serves the existing desktop renderer. These records use positive SQLite integer identifiers, represented by typed Rust wrappers.

The server exposes no agent, graph-mutation, or harness-execution API in this slice. Its capabilities document those components as unavailable. Managed Codex authentication remains an Electron service until the provider-to-harness contract is designed and implemented.

Electron starts the server on a random loopback port with an application-profile data directory and renderer directory. It sends a random control token to the child through standard input rather than exposing the token in process arguments. Before loading the renderer, Electron installs that token as an HTTP-only same-site cookie. Electron terminates the child process during application shutdown and before update installation.

## Consequences

- Project and thread recovery can be exercised independently from model inference.
- A thread and its first product interaction record are committed atomically.
- Standalone threads have no project identifier; project threads reference a validated local folder record.
- No TypeScript product server, graph engine, or harness runner is introduced in this slice.
- The product-state API returns interaction chronology, not desktop-synthesized graph nodes. Graph core will later create the canonical user-interaction node using the same integer identity inside a shared SQLite transaction.
- Graph and harness components can be integrated later without making PR #4 depend on PR #2.
- Credential adapters remain Electron-owned in this slice. Propagating credentials to a selected harness is deferred; the app server must not claim ownership of credentials yet.
