# Desktop update AWS authority

These inert policies define the exact S3 and GitHub OIDC authority needed by the Preview publisher and Stable promoter. They cover Apple Silicon, Intel macOS, and Windows independently without granting broad bucket listing, deletion, ACL, bucket-policy, or role-management access.

The Preview role can read and conditionally write immutable release objects, target-specific `beta*` pointers, Preview history, and Preview receipts. The Stable role can read exact Preview evidence and release objects but can write only target-specific `latest*` pointers, Stable history, and Stable receipts. Stable cannot replace release artifacts or Preview control objects. Before reading an object, each publisher issues a one-key existence probe. Both roles can use `ListBucket` only when that exact prefix belongs to the same readable namespaces, so a missing object does not become an indistinguishable `403` and unrelated bucket keys remain unavailable.

The trust policies require the immutable GitHub owner and repository IDs, the exact protected environment, and the `sts.amazonaws.com` audience. They do not accept branch, pull-request, or unscoped repository subjects.

## Review current state

AWS authentication is intentionally separate from GitHub and Azure. The repository-scoped roles are deliberately separate from the legacy `relayer-desktop-update-*` roles, which may still serve another repository. After an approved read-only login, inspect the repository-scoped roles before applying anything:

```sh
aws iam get-role --role-name relayer-graphcomplete-desktop-preview
aws iam list-role-policies --role-name relayer-graphcomplete-desktop-preview
aws iam list-attached-role-policies --role-name relayer-graphcomplete-desktop-preview

aws iam get-role --role-name relayer-graphcomplete-desktop-stable
aws iam list-role-policies --role-name relayer-graphcomplete-desktop-stable
aws iam list-attached-role-policies --role-name relayer-graphcomplete-desktop-stable
```

Compare every current inline and attached policy before replacing one. A missing permission should be added only to the exact ARN represented here; do not broaden to the whole bucket. Do not repurpose or delete the legacy roles during this migration.

## Apply after explicit approval

These commands change live IAM authority and must not run without separate approval:

```sh
aws iam create-role \
  --role-name relayer-graphcomplete-desktop-preview \
  --assume-role-policy-document file://infra/aws/desktop-release-authority/preview-trust-policy.json \
  --description "Relayer GraphComplete desktop Preview publisher via GitHub OIDC"

aws iam put-role-policy \
  --role-name relayer-graphcomplete-desktop-preview \
  --policy-name relayer-graphcomplete-desktop-preview \
  --policy-document file://infra/aws/desktop-release-authority/preview-policy.json

aws iam create-role \
  --role-name relayer-graphcomplete-desktop-stable \
  --assume-role-policy-document file://infra/aws/desktop-release-authority/stable-trust-policy.json \
  --description "Relayer GraphComplete desktop Stable promoter via GitHub OIDC"

aws iam put-role-policy \
  --role-name relayer-graphcomplete-desktop-stable \
  --policy-name relayer-graphcomplete-desktop-stable \
  --policy-document file://infra/aws/desktop-release-authority/stable-policy.json

gh variable set DESKTOP_UPDATE_PREVIEW_ROLE_ARN \
  --repo vishaltandale00/relayer-graphcomplete \
  --body arn:aws:iam::647746916062:role/relayer-graphcomplete-desktop-preview

gh variable set DESKTOP_UPDATE_STABLE_ROLE_ARN \
  --repo vishaltandale00/relayer-graphcomplete \
  --body arn:aws:iam::647746916062:role/relayer-graphcomplete-desktop-stable
```

Re-read all four policies after applying them. A successful IAM write is not evidence that publication, installation, updating, or promotion works.
