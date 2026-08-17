# ADR 0002: Start the Relayer app server as a product persistence skeleton

Status: accepted

## Decision

The first Relayer app-server slice is a Rust process tied to the Electron desktop lifecycle. It owns durable local records for projects, threads, and interactions in SQLite and serves the existing desktop renderer.

The server exposes no agent, graph-mutation, or harness-execution API in this slice. Its capabilities document those components as unavailable. Managed Codex authentication remains an Electron service until the provider-to-harness contract is designed and implemented.

Electron starts the server on a random loopback port with an application-profile data directory, renderer directory, and random control token. Before loading the renderer, Electron installs that token as an HTTP-only same-site cookie. Electron terminates the child process during application shutdown and before update installation.

## Consequences

- Project and thread recovery can be exercised independently from model inference.
- A thread and its first interaction are committed atomically.
- Standalone threads have no project identifier; project threads reference a validated local folder record.
- No TypeScript product server, graph engine, or harness runner is introduced in this slice.
- Graph and harness components can be integrated later through explicit product contracts.
- Credential adapters are explicitly deferred; the app-server skeleton must not claim ownership of credentials yet.
