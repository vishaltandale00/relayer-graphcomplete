# PR 494 third review follow-up

Base: `c70d527a918a72a99fda1588a53095404386dbe3`. The user authorized merging PR 494. Main integration passed local check/build and GitHub CI, but four unresolved review threads blocked merge. This follow-up addresses those findings before merging.

## Changed seams and checkpoints

| Seam | Promise and deterministic checkpoint |
| --- | --- |
| Retried completion asset authority | A newly admitted attempt may use assets; old attempts retain no authority. Exercise graph capability admission and host generation fencing together. |
| Successful graph import finalization | Publish accepted asset content and associations atomically, then remove temporary staging bytes. Fault before transaction commit preserves staging and permits retry. |
| Trusted review discovery during asset loading | Register validated controls before slow asset resolution. A held resolver must not hide ordinary link/navigation controls; disposal still removes registration. |
| Durable registry relationship provenance | Registry default relationships stay read-only; user-added relationships remain removable before and after durable reopen. |

These repair existing authority, asset lifetime, and review promises. They do not activate production presentation defaults or change model selection.

## Required verification

Run focused production-seam regressions and independent source review for each scope. Run `npm run check` and `npm run test:desktop:visual-node-details` (which includes `npm run build`) on the final source. Record hashes and fresh CI before merge. No paid inference or release proof is included.

## Evidence status

The trusted-control timing regression failed before the fix and the complete Node Detail runtime suite passed 42/42 afterward. Remaining evidence will be recorded after implementation and independent review.

Independent reviews are clean for UI timing, import cleanup, retry authority, and final catalog provenance; exact hashes are in the review JSON files. The first library review found unsafe legacy inference and a post-await authority snapshot; both were repaired and rereviewed.

Legacy V1/V2 catalogs cannot reconstruct which relationships were bootstrap defaults. Migration conservatively protects all existing relationships; V3 records the exact distinction for subsequent work. It does not silently relax old protection.

Focused tests passed: 42 Node Detail runtime, 5 import transport, 36 graph-server unit, 4 host bridge, and 47 asset-library tests. The first full check and desktop proof passed, but catalog source changed during that check. Final-source checks are rerun and recorded separately.

Final-source `npm run check` and `npm run test:desktop:visual-node-details` passed. The desktop entry point includes `npm run build`; no paid inference ran. The final manifest SHA-256 is `416e199c1e0ac3008b51fc8c797200fbb2b8e2f8eefb4369bd11b08b43a71a3f`. Manifest, representative original/imported captures, and final logs are retained here. All final review hashes were rechecked against current source.
