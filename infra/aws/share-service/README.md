# Share service AWS resources

Inert CloudFormation for the shared-thread snapshot service (issue #457, phase 0). It creates one private S3 bucket, one DynamoDB table, one Lambda with placeholder code behind an HTTP API, one CloudFront distribution on the share subdomain, and one GitHub-OIDC deploy role that can only update the function code, publish viewer assets, and invalidate the edge. Nothing here authorizes an AWS login or a stack change by itself; apply only after explicit approval.

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

## 3. Create the stack

```sh
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name relayer-share-service \
  --template-file infra/aws/share-service/template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    CertificateArn=<CertificateArn> \
    Auth0ClientId=<Auth0 Native Application client id>
```

Then read the outputs:

```sh
aws cloudformation describe-stacks --region us-east-1 --stack-name relayer-share-service \
  --query 'Stacks[0].Outputs' --output table
```

## 4. Point the subdomain at CloudFront

In Cloudflare add `share.relayerlabs.ai` as a CNAME to `DistributionDomainName` from the outputs, DNS only (grey cloud). CloudFront terminates TLS with the ACM certificate; a proxied record would double-terminate.

## 5. Wire GitHub

Create a protected environment named `share-service` on the repository and set the variable `SHARE_SERVICE_DEPLOY_ROLE_ARN` to `DeployRoleArn` from the outputs, plus `SHARE_SERVICE_FUNCTION_NAME`, `SHARE_SERVICE_BUCKET`, and `SHARE_SERVICE_DISTRIBUTION_ID`. The trust policy accepts only that environment's OIDC subject, using the same immutable owner and repository ids as `infra/aws/desktop-release-authority`.

## 6. Record the names on #457

Paste the outputs table into the issue so phases 4 and 5 can start.

## What the deploy role cannot do

List or delete bucket objects outside `assets/`, touch `snapshots/`, read or write the table, change IAM, or change the distribution. The Lambda's own role is the only principal with access to `snapshots/` and the table.
