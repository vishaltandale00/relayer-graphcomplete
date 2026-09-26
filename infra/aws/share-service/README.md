# Share service AWS resources

Inert CloudFormation for the shared-thread snapshot service (issue #457, phase 0). It creates one private S3 bucket, one DynamoDB table, an API Lambda and a streaming page Lambda with placeholder code, one CloudFront distribution on the share subdomain, and one GitHub-OIDC deploy role that can only update both functions' code, publish viewer assets, and invalidate the edge. Nothing here authorizes an AWS login or a stack change by itself; apply only after explicit approval.

DNS for `relayerlabs.ai` lives in Cloudflare, not Route 53, so two records are added by hand.

## 1. Sign in on the Mac

```sh
aws login
```

The browser opens, the session is stored locally, and no credential passes through this repository or a chat.

## 2. Request the certificate (us-east-1, required by CloudFront)

```sh
aws acm request-certificate \
  --region us-east-1 \
  --domain-name share.relayerlabs.ai \
  --validation-method DNS \
  --query CertificateArn --output text
```

Read the validation record and add it in Cloudflare as a CNAME (DNS only, not proxied):

```sh
aws acm describe-certificate --region us-east-1 --certificate-arn <CertificateArn> \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Wait until `Status` is `ISSUED`:

```sh
aws acm describe-certificate --region us-east-1 --certificate-arn <CertificateArn> --query Certificate.Status
```

## 3. Validate and prepare the stack

```sh
aws cloudformation validate-template --region us-east-1 \
  --template-body file://infra/aws/share-service/template.yaml
uvx --from cfn-lint cfn-lint infra/aws/share-service/template.yaml
```

The prepared stack is not the share feature. Its handlers return 503. Review the
change set before execution; the command below creates it without executing it.
Certificate status must be ISSUED before executing the change set.


```sh
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name relayer-share-service \
  --template-file infra/aws/share-service/template.yaml \
  --no-execute-changeset \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    CertificateArn=<CertificateArn> \
    Auth0ClientId=<Auth0 Native Application client id>
```

After reviewing and explicitly executing the change set, wait for stack completion. Then read the outputs:

```sh
aws cloudformation describe-stacks --region us-east-1 --stack-name relayer-share-service \
  --query 'Stacks[0].Outputs' --output table
```

## 4. Point the subdomain at CloudFront

In Cloudflare add `share.relayerlabs.ai` as a CNAME to `DistributionDomainName` from the outputs, DNS only (grey cloud). CloudFront terminates TLS with the ACM certificate; a proxied record would double-terminate.

## 5. Wire GitHub

Create a protected environment named `share-service` on the repository and set the variable `SHARE_SERVICE_DEPLOY_ROLE_ARN` to `DeployRoleArn` from the outputs, plus `SHARE_SERVICE_FUNCTION_NAME`, `SHARE_SERVICE_PAGE_FUNCTION_NAME`, `SHARE_SERVICE_BUCKET`, and `SHARE_SERVICE_DISTRIBUTION_ID`. The trust policy accepts only that environment's OIDC subject, using the same immutable owner and repository ids as `infra/aws/desktop-release-authority`.

## 6. Record the names on #457

Paste the outputs table into the issue so phases 4 and 5 can start.

## What the deploy role cannot do

List or delete any bucket objects, touch `snapshots/`, read or write the table, change IAM, or change the distribution. The API role can manage staged and published objects and share rows. The page role can only read published snapshots, read rows, and call UpdateItem on the table. Counter-only writes are a service-handler requirement; IAM does not restrict which row attributes can change. Code deployment transitively controls what each function does with its runtime role; this is not isolation from a malicious deployer.


## 16 MiB transport revision

See [ADR 0011](../../../docs/decisions/0011-shared-thread-snapshot-service.md).
The original #457 single-call upload protocol is replaced by reserve, signed S3
POST, and authenticated finalize. HTTP API carries only small metadata. The
browser still receives the snapshot inline: `/t/*` uses a separate Lambda
function URL with response streaming, AWS_IAM, and CloudFront OAC. That route
includes install redirects. `/assets/*` remains private S3 with OAC.

The lifecycle rule removes abandoned `staging/` objects after one day. It does not
expire published snapshots or old asset versions. The code deploy role cannot
change function configuration, IAM, URLs, tables, or distribution settings.

## Verification checkpoints

- Template resources, intrinsic dependencies, properties, and IAM actions:
  `uvx --from cfn-lint cfn-lint infra/aws/share-service/template.yaml` plus AWS
  `validate-template`. Neither command proves runtime behavior.
- Snapshot isolation, upload staging, function URL authority, edge route/cache
  settings, deploy scope, and placeholders: adversarial review of the exact
  template digest. This is a configuration review, not end-to-end certification.
- Owner-attempt idempotency and the successful-create quota share the retained
  table. Implementations use typed reservation, quota-day, and published-share
  items plus one conditional `TransactWriteItems` publication boundary. IAM
  authorizes that API through its underlying item actions, including
  `ConditionCheckItem`; DynamoDB has no separate `TransactWriteItems` IAM action. Only
  published share items project `ownerHash` and `createdAt` into `byOwner`.
  The runtime role includes transaction authority; this template capability is
  not evidence that the handler uses it correctly.
- No deterministic service runner exists yet. Upload finalization, concurrent
  quota enforcement, replay safety, deletion, and streamed 16 MiB output are
  unmapped runtime checkpoints for phase 4. Run `npm run check` as the repository
  fallback and `npm run build`; do not mark these service checkpoints passed.
- Before phase 4 launch, test real 16 MiB upload and worst-case escaped page
  delivery through the deployed origins, exact 404 parity, owner deletion, and
  rejected direct function-URL access. Use synthetic data and no paid inference.

## Gate B reconciliation (2026-09-25)

PR #460 superseded the still-open PR #459 and is merged in `main`. The current
stack remains the provisioned placeholder recorded below. Local Gate B keeps the
16 MiB staged-upload and streamed-page design: API Gateway carries metadata only;
S3 carries the frozen JSONL bytes; the page function streams HTML plus inline
snapshot bytes. CachingDisabled and `no-store` make a strongly consistent deleted
row check the public-access boundary; immutable viewer assets remain under their
per-commit prefix.

The local service contract requires an atomic owner-attempt reservation,
quota-day counter, and published-share write. The original runtime policy lacked
`dynamodb:ConditionCheckItem`, one underlying permission used by the transaction;
the template now declares that future runtime authority. No stack update, IAM change, deployment, cache invalidation, AWS
validation, or live capacity claim was performed as part of this reconciliation.
The 30-second HTTP API integration deadline and worst-case escaped 16 MiB streamed
page remain Gate C measurements. If synchronous finalization cannot meet the API
deadline, deployment must adopt the already-documented asynchronous finalization
job and polling design rather than lowering the product limit.

## Historical preparation record (2026-09-18)

AWS account: `647746916062`, region: `us-east-1`.
Certificate requested for `share.relayerlabs.ai`:
`arn:aws:acm:us-east-1:647746916062:certificate/976a6d4a-b1c0-4037-bc5c-45b4811a1c97`.
Its DNS-only validation CNAME has been added to Cloudflare and resolves publicly.
At this preparation checkpoint, no share resources had been provisioned. The subsequent provisioning result is recorded below.
The existing desktop update bucket, distribution, and IAM roles are separate.


## Provisioned (2026-09-19)

The owner approved execution. The stack is now `UPDATE_COMPLETE` and the public
origin is `https://share.relayerlabs.ai`. See [DEPLOYMENT.json](DEPLOYMENT.json)
for exact outputs and [SETUP-EVIDENCE.md](SETUP-EVIDENCE.md) for verification and
the streaming-placeholder correction. GitHub environment `share-service` allows
only branch `main` and has all five deployment variables. No deployment workflow
or actual share handler has been added; the public API and page return 503.
