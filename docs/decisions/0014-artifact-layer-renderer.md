# ADR 0014: A layer renderer reads an artifact node

Status: accepted (2026-10-07); implementation not started

## Context

Agents build websites, apps, documents and media, but Relayer can only show
graph nodes. Issue #684 settled what users need, and a throwaway prototype
(branch `claude/relayer-artifact-viewer-acfefa`) exercised it against a fixture
thread. Artifacts must keep the graph's draft, accepted and stopped states and
its portability. Agent-made content must never run with Relayer's authority.

## Decision

1. **The artifact is a node; the layer chooses how to read it.** A layer gains
   an optional `renderer`, whose only non-default value is `artifact`. A node
   gains an optional `artifact` record holding source, kind, part, viewport,
   starting state and the accepted fingerprint. An `artifact` layer has exactly
   one member node. Neither field changes completion authority, acceptance or
   graph states.
2. **The viewer is an isolated Electron view, not part of the main window.**
   Each artifact node renders in its own `WebContentsView` with its own
   partition and no preload. A custom scheme serves thread-folder files with
   byte ranges. Window, navigation, permission and download hardening follow
   the draft-preview capture window. The main window's CSP does not change.
3. **Filesystem checks live in the harness host.** Graph-core stays
   filesystem-free. Path containment, existence, kind and fingerprint checks go
   through a host bridge operation, as visual-asset preparation already does.
   Rejections are repairable validation issues; a failed fingerprint fails
   acceptance like a failed asset pin.
4. **The server invoke is deterministic.** An app artifact's details carry its
   server invoke: a start command, a loopback ready URL and an idle timeout.
   Desktop main runs it under the thread's permission profile, never a model,
   and leaves no graph record. On macOS a Seatbelt profile confines Ask and Auto
   threads to writing in the thread folder. Approvals are kept per thread and
   command in the desktop profile.
5. **Unknown renderers fall back.** A surface that does not know a layer's
   renderer draws it as an ordinary graph, so older readers stay correct.

## Consequences

- One more harness-host bridge operation and one more Electron view type.
- Graph records stay portable: export, import and shared snapshots carry the
  new fields unchanged. Shared snapshots omit annotation screenshots.
- Fingerprints make drift visible without copying large files into storage.
- Artifact partitions are persistent and cleared on every open and close.
  Chromium's PDF viewer does not start in an in-memory session.
- Office rendering depends on third-party renderers: docx-preview, SheetJS
  and an MIT-licensed PowerPoint renderer (decision 2026-10-08). They run in
  the artifact's isolated view, never in Relayer's page.

## Alternatives rejected

- **An iframe in the main window.** It needs a looser main-window CSP and puts
  agent code inside Relayer's page.
- **The artifact as a whole-layer object.** Several views of one artifact would
  need shared state between layers.
- **Copying artifact bytes into the graph store.** Videos and site folders are
  too large, and the thread folder is already the source of truth.
