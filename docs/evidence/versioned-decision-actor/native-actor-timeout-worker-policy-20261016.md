# Native query portfolio resource policy

The default check on source5a760ba458b7c1069c4bc4b0be7918489c53ab642f03100eb755ddc7c6ae1e13 passed all native stages, then failed one of4368 Vitest tests. The Mac search-target integration received wall_time_exceeded instead of granted. The production query budget remains250ms; this was not the test's60-second outer timeout or the5-second index-write ceiling. The other4367 tests passed and3 were skipped. Secret-boundary, Python and final lint/readability stages were unreached in that command. The failed log remains check-finalized.log.

The unchanged two-target search cases passed alone in6.74seconds. This supports resource sensitivity; it does not conclusively establish the original failure's cause. No query limit, test deadline, expected result, native source or assertion is changed.

CI documentation already assigns worker policy to vitest.config.js and describes a shared4-vCPU runner with three workers. The isolated project now explicitly caps file workers at three on larger hosts too. The process-bound project's single worker, later group order, file set and all tests remain unchanged. This trades additional parallelism on larger machines for the documented bounded resource profile. There is no CLI or environment override. A worker environment override would also overwrite process-bound serialization, so none is used.

| Checkpoint | Changed seam and boundary | Verification |
| --- | --- | --- |
| NAT-011: Bounded test resource policy without weakening native authority | Isolated project maxWorkers3; docs/agents/ci.md guidance; process-bound stays1 and groupOrder1 | Existing actual native search-target cases, then the entire default npm run check on the qualified source; all335 files and4368 tests remain selected, with existing skips unchanged. Full outcomes are separately recorded, not inferred from the focused pass. |

A new literal-value unit test would mirror the setting. The existing real native query fixture and full runner observe the consequence-bearing seam directly. No test is deleted, filtered or retried by the configuration. The earlier plan and static source review remain bound to their exact bytes. The qualified40-file source manifest adds only the Vitest configuration and CI guide to the finalized38-file manifest; production and standalone browser/desktop test code is unchanged. The passing full browser and desktop proofs are reused only for those identical inputs. Final check/build/compiled outcomes and the qualified review are recorded separately.
