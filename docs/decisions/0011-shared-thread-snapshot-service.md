# ADR 0011: Shared thread snapshots with bounded uploads and streamed pages

Status: accepted product direction; infrastructure provisioned with placeholders, service not implemented.

The immutable snapshot and reader boundary is defined by
[ADR 0012](0012-immutable-shared-thread-snapshots.md).

Issue #457 defines account-owned, immutable, read-only thread snapshots. On
2026-09-18 the owner retained the 16 MiB payload limit after the AWS transport
limits were identified. A direct API Gateway/Lambda upload and buffered HTML
response cannot carry that payload. Electron main instead uploads through a
short-lived S3 POST policy; a separate page Lambda streams the inline snapshot
through CloudFront. The payload remains conversation-export v1 JSONL.

The [PRD section 8.4](../prd/index.html) owns product meaning. This decision
supersedes only ADR 0008's exclusion of a Relayer service consuming the desktop
session: the share API verifies the existing Auth0 ID token with the native
client audience. Login remains direct Auth0; there is no custom session or user
table. Ownership uses a domain-separated one-way hash of the verified subject.

It also amends ADR 0009's network scope. Rust exports accepted records and scrubs
known secrets and private paths. Electron main owns both service and signed S3
requests; the desktop renderer receives neither tokens nor upload credentials.
The public viewer is a separate network surface outside desktop error reporting.
It has no telemetry client, cookies, or per-visitor identity. Public page hits and
install clicks update aggregate server counters only.

The viewer reuses the production workspace in a stripped browser shell with a
snapshot-backed adapter. Every published snapshot format remains readable.
Snapshot bytes stay inline in streamed HTML; no browser snapshot-fetch authority
is needed. Use a CSP with `connect-src 'none'`, safe JSON embedding, no third-party
scripts, and no-index metadata.

## Share title and snapshot boundary

Both signed-in and newly signed-in users enter a separate share title before
creating a link. The field starts blank; `Create link` remains disabled until it
contains non-whitespace text. The chosen title replaces the original title in
the published snapshot, page, browser tab, and preview. Local thread metadata is
unchanged. Publish the share title and project name unchanged; the content
redaction boundary does not scrub these user-selected public metadata fields.
Published titles cannot be renamed: a changed title requires a new share.

`Create link` freezes the accepted history at that moment. Retries reuse the same
frozen snapshot instead of exporting newly accepted records.

An oversized snapshot fails without publication or truncation. The desktop shows
a generic error message and the attempt reference without exposing the size-limit
reason. Export, oversize, upload, service, and unexpected deletion failures use
that same reference in a main-owned handled-failure event. The closed event admits
only reference, stage, code, optional snapshot bytes for the oversize code, the
existing safe app diagnostics, and the main-derived pseudonym. It is deduplicated
by account, reference, stage, and code. Cancellation, sign-in requirements, and
quota limits remain excluded. Titles, project names, conversation content,
credentials, raw errors, and request data are forbidden. Telemetry availability
cannot alter publication or deletion. The public viewer remains outside reporting.

## Upload and publication boundary

`POST /shares` authenticates and reserves an owner-bound upload. It returns a
server-selected staging key and a short-lived signed POST policy, not a published
link. The policy fixes that key and enforces a maximum object size of 16 MiB.
Electron main sends the already scrubbed JSONL directly to S3. It then calls
`POST /shares/{id}/finalize` with its Auth0 session.

Finalization checks ownership, expiry, the daily cap, total size, line count, and
JSON syntax. It reads and validates one exact object identity. Conditional copy
must bind the copied bytes to the validated ETag (or an exact version), since an
unexpired signed POST can be replayed. Final snapshot keys are server-owned and
never reused. Concurrent finalization must not overwrite a published object or
resurrect a deleted share. Publication and the 20-per-day quota use conditional
DynamoDB writes/transactions. Retry returns the same finalization result; a new
Share action creates a new identity. Bound reservations to prevent unbounded
staging abuse; failed/abandoned uploads never become public. Finalization must
finish within the HTTP API integration deadline (at most 30 seconds), despite the
longer Lambda timeout. If that cannot be proven at the maximum payload size,
phase 4 must use an asynchronous finalization job and polling before launch. Delete staged objects
on success, and expire leftovers after one day as a backstop.

## Page and deletion boundary

CloudFront routes `/t/*` to an AWS-IAM function URL with response streaming and
origin access control. Both Lambda invoke permissions are scoped to that
CloudFront distribution. S3 origin access is limited to `assets/*`; staged and
published snapshots are never exposed directly through the S3 origin.

The page function has snapshot read authority and table read/counter-update
authority. Counter-only updates are a handler contract: IAM UpdateItem permits
arbitrary updates within the table. It checks deletion with a strongly consistent base-table read
before writing response bytes. Counter updates are conditional on an existing,
non-deleted share and must not recreate rows. Unknown and deleted links return
the same 404. Successful pages, redirects, and errors use `no-store`; CloudFront
page caching and error caching are disabled. A deletion stops new reads; bytes
already delivered to a visitor cannot be recalled.

`/t/{id}/install` is owned by the page function too. It conditionally records the
click and redirects to the fixed install destination. HTML escaping can increase
response size substantially; the page timeout is 120 seconds and the service
must bound generated bytes and test worst-case 16 MiB inputs before launch.

## Evidence and deployment

The infrastructure template is inert, with 503 placeholders. Schema validation,
policy review, and a deployed placeholder do not prove sharing. The service and
desktop implementation still require upload replay/race, ownership, quota,
delete, large streamed-page, redaction, and viewer evidence. See the
[infrastructure runbook](../../infra/aws/share-service/README.md).

AWS references: [HTTP API limits](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html),
[Lambda streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html),
[function URL OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html),
[S3 POST policies](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html).
