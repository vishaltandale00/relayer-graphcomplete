# Evaluator improvements verification — 2026-10-05

## Required plan

Checkpoints EVAL-007–011 and changed seams are mapped in the adjacent README. Required gates were the six focused in-process test files, build, compiled-runtime tests, the full evaluator browser runner, and `npm run check`. Reviews cover authority and product/UX mapping. No tests were retired.

## What ran and evidence

- Focused in-process run: 113 tests passed across six files in 2.88 seconds. Fixtures observe committed structured approval versus drafts, actual release-bound v2 evidence/export/reopen, changed code/test priority, helper exclusion and capture consistency, and exact v5 unfinished-stop authority while legacy stopping remains gated.
- `npm run build`: passed.
- `npm run test:eval-compiled-runtime`: all four scenarios passed in 10.54 seconds.
- `npm run test:eval-web`: all reported browser chapters passed, including explicit three-revision release selection with completion v2, exact run/export pins, uncertain participant stopping, calibration, actor structured input and native product restart. Inference was fixture-driven.
- Final `npm run check`: passed Rust formatting/clippy/tests, crash reconciliation, package builds and type checks, 3,578 Vitest tests (three skipped), two secret-boundary tests, 68 Python tests, receipt lint and PRD readability.
- `git diff --check`: passed.

Final 19-file source digest: `65cf6c7e1f7035c4fb4edc7b07c4929a801cbfb767e6762bba9ebb4c9e1a289d`. Scope and digest method are stored in `improvements-source-scope.txt` and `improvements-review.json`. The focused/build/compiled/browser gates tested the preceding source digest `ff7cc339f3d220840f10d76e0fe6036efa1561a90849d7ca9ce9d8ca4a64f2bb`; only sentence splitting in the PRD changed afterward. The final full check tested the final digest. Two refreshed adversarial reviews found no unresolved findings; their assertions are non-certifying without a PR and do not independently certify gate execution.

## Failures and limits retained

The initial regression run failed two scenarios (missing committed approval and omitted changed artifacts); an independently isolated unfinished-stop regression also failed before implementation. Intermediate fixture failures exposed legacy contract assumptions and missing isolated Git refs; both were repaired before the final focused run. The first full check passed its executable suites but failed three new PRD sentences over the readability limit. Those sentences were split without changing meaning; the final full check passed.

No new live-model inference, calibration claim, promotion, merge or release proof is included. Earlier three-case live observations remain in the private smoke evidence. Deterministic and fixture-browser results establish the production seams, not live actor or reviewer quality.

## Log identities

Raw logs are retained locally under ignored `.relayer/evaluator-improvements-2026-10-05/`. Hashes identify the exact logs; they are not substitutes for scenario results above.

| Log | SHA256 |
| --- | --- |
| red | `de8f2e0a9945d6c4dec0588ad0eb45cc9dc9e099bbdf43dedbbf563283b0abf0` |
| warm6 | `6f599e73f433b507e923961406d72de049b0366bc0859f1f9cad32d0fd91ab25` |
| build | `d000728fad9ba7f93bb869bea14e09a22c90137a7c0739d60ad9af7a37e7315d` |
| compiled | `1cc28a5c12bbde4c5dbe7a7f34af9cad3e428d493f4c8d643316812704ff8ee8` |
| browser | `1b6a16819c32a3fb14456630f91d961bc41617ae1ecc44b6ecb1ec7d70648988` |
| check | `13c0dda614c0850f7fc8bf8889334ea5e28c7d5d27dedf6df0c52c27cc5d3fb9` |
| check-final | `8049e9b1c5117906c3f25ca053bfb66faa2d23728574408e3f3cea12340f253c` |
