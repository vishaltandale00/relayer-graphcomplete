# Windows ordinary-startup repair checkpoints

The first signed Windows candidate at source `649e06982307f4407c808ce7a4a8bafdf71ab8b0`, workflow `37388970057/1`, failed interactive startup while reconciling the derived Ladybug store (`Access is denied`, OS error 5). The old engine-only qualification flag bypassed ordinary startup and StoreLayout. SQLite remains canonical; no search fallback or authority change is part of this repair.

## Required plan and executable seams

| Seam / promise | Deterministic checkpoint | Platform proof |
| --- | --- | --- |
| Existing file bytes survive flushing; open/flush errors propagate | StoreLayout legacy snapshot and generation publication/retention tests in `store::layout_tests` | The Windows capture runs those real Rust tests against its native build |
| Atomic pointer replacement and quarantine/independent rollback copies preserve prior generations | New nested-file publication/replacement scenario plus existing `ladybug_search_lifecycle` failure, reconciliation and symlink scenarios | Windows create/replacement/copy scenarios; no new power-loss claim |
| Ordinary desktop graph server becomes ready and reopens its persisted generation | `proveNormalGraphServerStartup` runs the real CLI with stdin ownership, fresh profile, clean shutdown and same-profile reopen; runner fixture rejects pre-readiness failure and generation replacement | Mandatory before every Windows packaged engine lifecycle, including verified native reuse |
| Old native receipts cannot bypass the newly required startup boundary | `windows-native-cache.test.mjs` rejects missing normal-startup fields | Fresh current-consumer startup proof remains required after artifact reuse |
| Reviewed build inputs retain their authenticated bytes on Windows | Real Git autocrlf checkout fixture verifies every approved build-configuration hash | LF attributes preserve the existing approved hashes; no hash relaxation |
| Qualified development application is available for interactive QA | Existing workflow test verifies capture output and success-dependent PR artifact upload | Copy after native/package proof, seven-day CI artifact; distinct Relayer Dev identity/profile |

## Execution and evidence

Run `npm run check` and `npm run build` before committing. Run Windows native/package qualification using the isolated `windows-qualification` PR lane. Preserve its receipt and development artifact from the exact tested merge source. The operator audit must require all 18 authenticated capture inputs (including `store.rs`), all three `normalStartup*` fields, and passing output for both named `layout_tests` scenarios. A zero-match Cargo exit cannot pass the capture checkpoint. Download/verify the GitHub artifact digest before VM extraction. Launch Relayer Dev using the interactive Windows user's desktop, capture visible UI and reopen, and bind that observation to app/server hashes and source. A copied development app is startup evidence, not a signed release. Final signed installer installation, launch and reopen remain separate acceptance steps.

A bounded NTFS API probe under SYSTEM demonstrated that `FlushFileBuffers` fails with error 5 for a read-only directory handle and succeeds for a writable directory handle with `FILE_FLAG_BACKUP_SEMANTICS`. This supports the repair but does not certify the interactive user, arbitrary filesystems, complete race-free confinement or power-loss behavior. Production Windows code additionally opens the final directory with `FILE_FLAG_OPEN_REPARSE_POINT`; existing confinement checks and error propagation remain.

This document records the plan and original failure. It does not assert a repaired Windows GUI pass before the actual artifact and VM observations exist.
