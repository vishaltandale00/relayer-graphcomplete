# Issue 471 — public share viewer evidence

This directory describes the deterministic Electron evidence seam for the
public, read-only shared-thread viewer. The capture uses a fixed synthetic
conversation-export v1 JSONL snapshot and the real production
`ProductWorkspace` and public-viewer assets. It never reads a local product
database, contacts a provider, or calls a deployed share service.

Run the opt-in capture from the repository root:

```sh
RELAYER_CAPTURE_PUBLIC_SHARE_VIEWER_EVIDENCE=1 \
  electron scripts/capture-public-share-viewer-evidence.mjs
```

The capture opens the viewer at a loopback-only fixture server and writes:

- `desktop-overview.png` at 1440x1000;
- `mobile-overview.png` at 375x812;
- `mobile-node-details.png` at 375x812 after opening Node Details;
- `synthetic-snapshot.jsonl`, the fixed fixture input; and
- `manifest.json`, which records the fixture digest, exact source commit and
  dirty state, hashes of the declared entrypoints plus every renderer resource
  actually served during the run, viewport image hashes, and the network/URL
  assertions.

The runner requires nested-layer and accepted-turn navigation to change the
rendered destination while proving an unchanged URL. It also verifies a
mobile pan displacement and reload back to the first accepted turn, and asserts
that no network request leaves the loopback fixture origin.
The page itself uses the
production public-viewer CSP with `connect-src 'none'`; the viewer has no
snapshot-fetch authority, cookies, telemetry, or mutation/execution controls.
The source-bound manifest makes a screenshot claim meaningful only for the
renderer sources and capture script whose hashes it records. A dirty source
tree is recorded as dirty rather than treated as a release proof.

This is local deterministic visual evidence for the viewer seam. It does not
prove deployed upload/finalization, Auth0 ownership, CloudFront streaming,
large-payload behavior, deletion, or live service availability. It also does
not use the real local conversation export; real exports remain outside the
repository and outside public evidence.
