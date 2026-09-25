# Shared-thread Gate B implementation Kanban

Source baseline: `origin/main` at `61ce7b0cc50ee819eb54568cb8fc7165bf6c1e01`.
UX reference only: `prototype/share-slice-1` at
`b7449a1a246abc2e87ecc175a0c56d7c2bd14062`.

This board tracks local production implementation for issues #462-#467. It does
not authorize deployment, publication, IAM changes, live Auth0 changes, live
Sentry submission, or promotion of prototype code.

## Ready

- [ ] `SHR-465-1` Reconcile the merged template, open PR #459, owner/attempt/quota
  storage needs, cache invalidation, and the 16 MiB staged-upload/streamed-page
  design. Proof: `cfn-lint`, local template assertions, and a written gap list;
  no live AWS command.
- [ ] `SHR-466-1` Freeze the coordinator contract shared by exporter and service:
  immutable bytes, owner-bound attempt/reference identity, closed progress and
  failure states, and renderer-without-network-authority. Proof: contract tests
  beside the main/preload boundary. Durable reopen remains blocked until
  `SHR-462-*` and `SHR-464-*` are stable.
- [ ] `SHR-467-1` Admit only export/upload/service/oversize handled failures from
  a verified account generation through Electron main. Proof: extend the real
  authenticated-error-gateway tests with local transport and account fakes.
- [ ] `SHR-467-2` Deduplicate on attempt + stage + closed code while allowing a
  changed stage/code. Proof: deterministic gateway/queue tests across retry and
  reconstructed attempt identity.
- [ ] `SHR-467-3` Allow only reference ID, stage, code, optional byte size, and
  existing safe diagnostics; reject title, project, content, credentials, raw
  errors, and request data. Proof: versioned privacy-corpus fixtures through the
  real validator and queue seam.
- [ ] `SHR-467-4` Exclude cancellation, sign-in requirement, quota, viewer
  telemetry, and telemetry-recursion effects. Proof: admission-negative tests
  plus viewer inventory assertion.

## In progress

- [ ] `SHR-462-1` Refuse imported threads and threads with no accepted
  completion. Proof: Rust production-service fixture.
- [ ] `SHR-462-2` Freeze only accepted history at Create link, preserving nested
  layers, action provenance, Node Details, and export-local references. Proof:
  Rust persisted-product fixture with pending work and shared/nested targets.
- [ ] `SHR-462-3` Strip permission/execution/configuration receipts and admitted
  model plans while retaining completion status, model selection, and harness
  configuration name. Proof: exact decoded JSONL assertions.
- [ ] `SHR-462-4` Redact known secrets, PEM/JWT shapes, home paths, and fragmented
  rich-detail paths while preserving the chosen title and project display name.
  Proof: Rust redaction fixtures at the share-export boundary.
- [ ] `SHR-462-5` Keep conversation-export v1 bytes, replace only the published
  title, preserve ordinary export behavior, and reject over 16 MiB without
  truncation using a closed error. Proof: boundary/adjacent size tests plus the
  unchanged ordinary-export suite.
- [ ] `SHR-463-1` Parse v1 into the production ProductWorkspace adapter with
  nested navigation and Node Details. Proof: adapter test using realistic v1
  fixture data.
- [ ] `SHR-463-2` Start/reload at the first accepted turn and keep the location
  URL unchanged during turn/layer navigation. Proof: browser-host test observing
  history/location calls.
- [ ] `SHR-463-3` Keep execution controls inert and open ordinary web links in a
  new tab. Proof: ProductWorkspace public-host action tests.
- [ ] `SHR-463-4` Safely embed snapshot/title/project data with escaping, CSP
  `connect-src 'none'`, no third-party scripts, noindex, static OG metadata, and
  no client telemetry. Proof: template/inventory tests with adversarial strings.
- [ ] `SHR-463-5` Preserve the accepted desktop shell, Environment panel,
  simplified success-adjacent viewer layout, mobile pan/details behavior, and
  render-failure Reload state. Proof: declared Electron fixture evidence at
  desktop and 375 px plus structural tests.
- [ ] `SHR-464-1` Verify Auth0 ID tokens via JWKS and derive a domain-separated
  owner identity server-side. Proof: handler tests with valid, invalid, expired,
  wrong-audience, wrong-issuer, and foreign-owner fake JWKS cases.
- [ ] `SHR-464-2` Reserve/upload/finalize exact v1 bytes using 128-bit IDs,
  versioned object keys, bounded size/line/JSON validation, and exact staged
  object identity. Proof: handlers with fake S3/DynamoDB adapters.
- [ ] `SHR-464-3` Make owner-scoped attempt retries and concurrent finalization
  return one immutable URL and one quota charge. Proof: deterministic concurrent
  attempt test including lost-response replay.
- [ ] `SHR-464-4` Enforce 20 successful creations per UTC day atomically, return
  reset time, and charge neither failures nor duplicates. Proof: concurrency,
  failure, and UTC-rollover adapter tests.
- [ ] `SHR-464-5` Enforce owner isolation and identical unknown/deleted 404s;
  retain source-thread association and immutable metadata. Proof: foreign-owner
  and 404-parity handler tests.
- [ ] `SHR-464-6` Serve/count public pages and install redirects without visitor
  identity, and pin viewer assets per publication. Proof: fake counter/cache and
  template-manifest tests.

## Review gate

- [ ] Integrate the issue work into one local exporter -> main authority -> fake
  service -> production viewer journey.
- [ ] Run focused checkpoints, declared heavy evidence, `npm run check`, and
  `npm run build`; record exact commands and failures separately from the plan.
- [ ] GPT-6 Astra adversarial review of semantic/UX/authority boundaries against
  the exact integrated commit or workspace digest. Without a PR, the verdict is
  non-certifying.

## Gate C / approval required

- [ ] Real AWS provisioning or changes, IAM changes, deployment/publication,
  CloudFront invalidation, live Auth0 mutation, live Sentry submission, and
  full-size live ingress/egress evidence.

