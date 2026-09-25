# Issue 407 hosted cancellation experiment

This is supplementary hosted evidence for issue #407. It tests the unchanged workflow from reviewed #407 on a combined tree containing the separately reviewed #356 Rust changes. It is **not** evidence that the combined tree is the exact #407 tree, and it does not show that either superseding push introduced Rust changes. The temporary PR touched Rust, and both superseding pushes targeted that same PR.

## Pinned source

- #407 reviewed commit H: `e17fea2f27d570dec7c564e93b8d6975602a48ca`; tree `b91192e49b0b20a3f1a27135626316bed7ed58c0`.
- #356 reviewed commit: `d693d3b168ba5c33d45c315d46534f9b81865e90`; base `61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01`.
- Combined commit C: `2db633c42734524ac7267b0c3f7ec90081b2af6b`; tree `19bf24a33787f0e640fb18ab5f2dbef73389b496`.
- A: `5436731ae1d364323b6f8f88bb5673e3c5c585b0`; B: `fe13ec4aaa4faee12f4247cf57adf72ff24f5c47`. A and B are empty commits with C's tree.
- The reviewed patch and source receipts are included in `raw/`. The workflow file blob is byte-identical across H, C, A, and B: `f2c37df5e7202a6340b22c8934a206f3cac96be8`.

## Local gates

On C, `npm run check` passed on one unchanged retry after the first attempt hit disk exhaustion and timing failures; the retry used a temporary directory on the SSD. The successful run reports 172 Vitest files passed, 1 skipped, 2,268 passed and 3 skipped. `npm run build` passed. The failed first attempt and diagnostic are retained; they are not hidden. Native binary pre/post hashes were equal, so this evidence does not claim those binaries were rebuilt. See `raw/check.log`, `raw/check-retry.log`, `raw/build.log`, and source/native receipts.

## Hosted runs

Temporary draft PR #484: https://github.com/vishaltandale00/relayer-graphcomplete/pull/484. It was not merged. Bootstrap run `36124510010` was manually canceled and is not proof. Push A run `36124661208` and push B run `36124809995` targeted the same PR. A's plan selected full mode and all named chapters; its Rust steps and Rust runtime build were active when B superseded it. A named cancellation replacement annotation was not found, so replacement attribution is inferred from the same-PR concurrency key and ordered push receipts.

In A, Clippy, fresh Rust tests, crash reconciliation, and runtime build commands were canceled. The Rust aggregate and Vitest job were waiting/appeared after the pre-B snapshot and then were canceled. The `check` aggregate ran under `always()` and failed its selected-job assertion because required jobs had been canceled. The Ladybug producer had already been skipped due to a cache hit (`lbug_cached=true`); this is **not** cancellation evidence. Jobs already complete or unavailable at the snapshot are not counted as canceled. GitHub timestamps have one-second resolution; cancellation delivery latency is therefore a coarse push-to-terminal interval, visible in retained receipts.

B was manually canceled for bounded cleanup after its partial observation; its completion is not a success result. Missing logs for canceled jobs and API snapshots are retained and called out in the `.error` files.

## Proof boundary

This demonstrates cancellation of active Rust work and cancellation of selected dependent lanes on the unchanged #407 workflow, on combined source C, under a real Rust-touching draft PR. It does not prove cancellation on exact tree H, does not prove a runtime cache miss for every lane, and does not close the issue's criterion beyond the recorded combined-tree scope. Review and acceptance judgment remain with the parent.

## Raw receipts

`raw/` preserves source and patch provenance, PR/run/job API snapshots, plan and workflow logs, push/cancel timestamps, full captured logs, and local gate receipts. `SHA256SUMS` records file hashes for these receipts (excluding itself).
