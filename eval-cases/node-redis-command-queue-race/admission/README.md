# Admission evidence

Primary upstream evidence:

- redis/node-redis issue #1593 reports the synchronous socket-error race and
  command/reply misassociation: <https://github.com/redis/node-redis/issues/1593>
- v3.1.2 pins annotated tag object
  `115b11829508162bf0776c68500b87de08d52560`, commit
  `4f85030e42da2eed6a178e54994330af5062761e`, and tree
  `3a360d5440b2d73831123df48e24b3422676bb16`:
  <https://github.com/redis/node-redis/releases/tag/v3.1.2>
- PR #1603 and commit `d8116963d4707ca38165a177259fd65809e3a83b`
  contain an upstream-submitted proposal that defers socket-error handling:
  <https://github.com/redis/node-redis/pull/1603>
- the pinned repository is MIT licensed:
  <https://github.com/redis/node-redis/blob/4f85030e42da2eed6a178e54994330af5062761e/LICENSE>

Both the issue and PR remain open. The sealed reference is therefore a proposed
upstream workaround, not a merged or released upstream fix and not a prescribed
candidate implementation.

Run `npm run eval:admit:node-redis` on macOS arm64 with Node 22.23.2 and npm
10.9.8 to materialize the pinned source, install the four integrity-checked
production dependencies, add and execute the candidate-owned regression, create
exactly one local commit, and run the production grader against this portfolio:

| Member | Expected | Distinguishing purpose |
| --- | --- | --- |
| untouched v3.1.2 | red | exposes the historical queue poison and shifted replies |
| upstream proposal | green | orders the error handler on the next tick |
| queue admission alternative | green | admits the in-flight command before socket write while preserving reply modes |
| clear queue on ready | red | hides queue length while losing failed callbacks |
| first error only | red | passes one epoch but poisons the queue on repetition |
| no reconnect | red | avoids later misassociation by abandoning recovery |
| no-op regression | red | uses a behaviorally correct repair but supplies a test that is not red on the untouched source |
| forged observations | red | poisons JSON and writes unsigned fd-3 data, which cannot forge the signed driver payload |

The verifier records `SET` and `GET` fault injection, callback cardinality, queue
cleanup, offline-command replay during reconnect, repeated independent errors,
ordered replies, final queue drainage, no command/reply misassociation, and CLIENT
REPLY ON/OFF/SKIP behavior as separate predicates. The admission runner enforces
the complete expected failure matrix for every member. It neither reads candidate
source text nor compares a candidate patch with either green solution.

`adversarial-review.json` records the reviewer, reviewed workspace digest,
verdict, and unresolved findings. The local assertions are durable admission
evidence but remain non-certifying until represented in a reviewed PR.
