# Issue 457 AWS setup evidence

Date: 2026-09-18 (America/Los_Angeles).
Base commit: `601460c1c9d29795d011beace0d35cad74b2e4e3`.
Branch: `codex/share-service-16mib-setup`. Uncommitted local preparation.

## Required verification plan

Validate the actual CloudFormation schema and intrinsic graph, review authority
and delivery boundaries, run PRD readability, and run the repository fallback
`npm run check` plus `npm run build`. Service handlers and desktop sharing do not
exist in this change, so their runtime checkpoints remain unproved.

## Executed infrastructure evidence

- AWS identity verified in account `647746916062`.
- ACM certificate `976a6d4a-b1c0-4037-bc5c-45b4811a1c97`, us-east-1, is ISSUED for
  `share.relayerlabs.ai`. The exact ACM validation CNAME was saved DNS-only in
  Cloudflare and resolved through both 1.1.1.1 and 8.8.8.8.
- `cfn-lint 1.57.0` passed on the final template.
- AWS `validate-template` passed on the revised topology; the final revision also
  produced an AVAILABLE change set with 19 Add actions and no existing-resource
  changes. This is planning evidence, not deployment evidence.
- Final change set: `share-457-16mib-reviewed`, ID
  `arn:aws:cloudformation:us-east-1:647746916062:changeSet/share-457-16mib-reviewed/0aaf031b-e366-4b31-b026-da1868484a2b`.
- Stack ID:
  `arn:aws:cloudformation:us-east-1:647746916062:stack/relayer-share-service/4a00a070-b3df-11f1-959b-12ffc3dc2e0b`.
  State is REVIEW_IN_PROGRESS; change set execution state is AVAILABLE.
- Retrieved AWS template bytes exactly match local SHA-256
  `cd68f4aa47ecec7872d08a4a9123fdb04bc9351223b68e93e63317382252ce8d`.
- The superseded initial change set was removed. No change set was executed.
- `npm run prd:check-readability`, `git diff --check`, and `npm run build` passed.
- `npm run check` exited 1 at Vitest because one suite could not import Electron
  during concurrent first-install extraction. All Rust suites, crash-recovery
  suites, Clippy, package checks and TypeScript checks preceding it passed.
  Vitest reported 171 files / 2,275 tests passed, 1 file / 3 tests skipped, and
  one failed suite with zero executed tests.
- After installation settled, the exact failed suite
  `test/desktop-renderer-error-reporting.test.mjs` passed all 3 tests in 82 ms.
  No product source was changed to make it pass.
- The remaining check stages were run explicitly and passed:
  `test:codex-secret-boundary`, Python unit tests, `lint:ladybug-receipt`, and
  `prd:check-readability`. The original outer `npm run check` failure remains
  recorded; it was not rerun or represented as a clean outer-command pass.
- Local logs: `/tmp/relayer-share-457/check.log`, `build.log`,
  `electron-retry.log`, and `remaining-checks.log`.

## Adversarial review

Reviewer: `share_infra_review`. Verdict: configuration review passes with no
unresolved blocker to change-set preparation. Reviewed template topology,
permissions, staging isolation, all supported error TTLs, 503 placeholders,
deploy authority, runbook, ADR 0011, PRD 8.4, and architecture appendix.
The hashes below identify the reviewed source. Without a PR this review is
non-certifying. It does not prove upload, rendering, quota, or deletion behavior.

```json
{
  "infra/aws/share-service/template.yaml": "cd68f4aa47ecec7872d08a4a9123fdb04bc9351223b68e93e63317382252ce8d",
  "infra/aws/share-service/README.md": "c98025b17bb8306532854f5eb758fe000284f4a43835aec3d5f32e76aed210a8",
  "docs/decisions/0011-shared-thread-snapshot-service.md": "c020147b39fcc1fbffab01ad5ad588730fb220601fd5fd6e9ec980d93ed7b47d",
  "docs/decisions/0008-direct-auth0-desktop-account.md": "dc4edb8042f4440fa95ac5fc338b1fb5ed9154619dce45e3e42ef178261d7e54",
  "docs/decisions/0009-authenticated-desktop-error-reporting.md": "2d0ad34c60848697daa92a9e71ed47ca90cf68435a35b311edc0f025362c1636",
  "docs/prd/index.html": "9919df0fd81cca4cd85f5b91c1ae4ea991aa19b2a8743052a718965704362f1e",
  "docs/architecture.md": "adb9bf62a4d6ceb9ee216a1a66d9ea355fd218957a813d3e416aeb9313abee61"
}
```

## Remaining execution and runtime proof

Execute the reviewed change set only after explicit deployment approval. Then
verify stack completion, runtime role policies, private bucket/URL access,
CloudFront 503 placeholders, and TLS. Point `share.relayerlabs.ai` to the new
CloudFront domain and configure the protected GitHub environment with the stack
outputs. Do not infer successful provisioning from this record.

Phase 4 must prove maximum-size upload and escaped streaming, signed-upload
replay races, ownership, daily quotas, finalization timeout, deletion/404 parity,
and conditional counters. The desktop and viewer require their own redaction,
accepted-history, compatibility, nested-layer, and mobile evidence. These are
explicitly pending, and no paid inference or real user snapshot was used.


## Approved provisioning and live verification (2026-09-19)

The owner explicitly approved executing the reviewed change set. Creation
completed. The first public page probe returned 502: the streaming placeholder
used `end(body)` without the explicit write and awaited finish sequence. CloudWatch
showed an invocation without an application exception. The corrected placeholder
uses `write(body)`, `end()`, and `await finished()`, matching the AWS streaming
tutorial. Its update change set was executed within the approved setup scope.
The only direct template modification was PageFunction.Code; CloudFormation also
listed inferred dependent URL/distribution/role reevaluations. No resources were
replaced, and IAM/topology source was unchanged.

Final template SHA-256:
`ef6ebd5cda391f7c94dab19b77c3c8c7d85514c3ff206feb44b6054dce8eebad`.
The template retrieved from the live stack matches these local bytes exactly.
Stack status is `UPDATE_COMPLETE`. See [DEPLOYMENT.json](DEPLOYMENT.json) for all
resource outputs, DNS, and HTTP statuses.

Reviewer `share_infra_review` reviewed the corrected handler at this exact digest
and confirmed that reversing only that change reproduces the prior reviewed
hash. Prior topology and IAM review remains applicable; the configuration review
is non-certifying without a PR. The deployment record below provides the separate
live evidence.

- CloudFront is Deployed and HTTPS validates for `share.relayerlabs.ai`.
- `/shares` and `/t/setup-check` return 503, the exact intended placeholder body,
  and `Cache-Control: no-store`.
- Direct unsigned page-function URL access returns 403.
- A synthetic asset uploaded through the operator credential returned its exact
  bytes through CloudFront (200), while direct unsigned S3 access returned 403.
- A known existing synthetic snapshot object also denied unsigned S3 access (403).
  Both probe objects were removed. The first probe helper hit an empty-output
  parsing error after successful deletion of its first object; the remaining
  object was matched to the exact synthetic marker and removed, then the corrected
  helper repeated the proof and cleaned both objects successfully.
- Bucket public-access blocks, staging-only one-day lifecycle, DynamoDB point-in-
  time recovery, runtime policies, deploy policy, and immutable OIDC subject were
  read back. CloudFront's bucket grant covers only assets and this distribution.
- GitHub `share-service` permits only branch `main`; all five variables match
  CloudFormation outputs. OIDC workflow execution has not been exercised because
  the phase 4 deployment workflow does not exist.

The initial 502 is preserved as a failure, not counted as a passed probe. These
checks prove infrastructure wiring and the placeholders, not the share feature
or maximum-size payload behavior. No real user snapshot or paid inference was used.

Final-source verification completed: `npm run check` and `npm run build` both
exited 0. Vitest reported 172 files and 2,278 tests passed, with one file and three
tests skipped; the separate secret-boundary suite passed two tests. Python passed
29 tests. Rust, Clippy, crash-recovery, package/TypeScript, receipt, and readability
stages all completed in the same successful check invocation. Logs are
`/tmp/relayer-share-457/check-final.log` and `build-final.log`.
`git diff --check` also passed. At completion of this September 19 verification
run, source and setup records were local and uncommitted; no branch had been
pushed, no PR had been merged, and no issue comment had been posted.
