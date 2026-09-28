# Hosted compilation inventory follow-up

Diagnostic only, separate from PR #546. No archive transport, production reuse,
coverage change, PRD product decision or test-execution replacement is proposed.
PRD §15E/16.1 and the existing CI chapter retain verification authority.

The completed #546 hosted artifacts contain identity, compiler statistics and
fresh test logs, but no Cargo JSON or ELF bytes. Reuse those existing timings
and negative transport result; one additional bounded hosted compilation is
needed to observe the intended profile's artifact and runtime shape. Do not
repeat the producer/consumer cache experiment.

The workflow runs only on its named experimental branch or explicit dispatch.
It uses the ordinary CI target path and line-tables profiles. The unchanged
native verifier and pilot identity derivation must succeed before compilation.
It captures all default workspace compilation artifacts without running tests,
then reports mapping, candidate runtime libraries and registry observations
independently. Reporter success never authorizes artifact reuse. The ordinary
production chapter and crash-feature lane are unchanged.

## Changed seams and required verification

| Seam | Checkpoint | Evidence |
| --- | --- | --- |
| Cargo target mapping | A newly added required target or missing example is visible; doctests and feature gates retain explicit obligations | Actual mapping fixture in `test_report.py` |
| Independent report sections | Missing provenance preserves successful observations and remains unknown | Section failure fixture |
| Candidate ELF dependency walk | Transitive libraries and unresolved names remain visible; candidate resolution is not loader authority | Recursive dependency fixture |
| Registry observations | Archive bytes are compared to lock checksums but cannot qualify extracted sources | Real temporary archive fixture |
| Hosted orchestration | Native admission precedes full compilation; no cache transport or required-CI connection | `ci-compiled-inventory.test.mjs` workflow checkpoint |

The Python scenarios run through Vitest. Existing conservative scripts/workflow
ownership selects the complete deterministic portfolio; no checkpoint or test
is removed. Pre-commit gates are `npm run check` and `npm run build`. Source-bound
adversarial review and one hosted inventory run are additional evidence. Outcomes
will be reported separately from this pre-execution plan.

## Decision boundary

An inventory mismatch, unavailable native qualification or unknown external input
is a blocker to reuse, not a reason to broaden trust. The reporter does not
reconstruct links, mutate registry sources, or run cached executables. Exact
registry archives alone do not qualify extracted bytes or reviewed source patches.
`ldconfig` candidates do not establish actual loader selection, Cargo environment,
dynamic loads or subprocess dependencies. Doctest/example execution equivalence
still needs its own proof before any executable-only runner.

The previous full-source 30-run audit found no eligible earlier successful
same-tree writer among 24 successful selected jobs. A broader static projection's
12/24 potential matches is not a qualified hit rate. Unless closure can be
qualified cheaply and expected reuse pays for validation/transport, recommend
no further cache implementation. No speedup claim follows from this report.
