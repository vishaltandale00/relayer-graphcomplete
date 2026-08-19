# Desktop release operations

This runbook covers the operator-controlled steps around the code-owned release contract in [ADR 0002](decisions/0002-desktop-release-contract.md). It does not authorize a tag, publication, Stable promotion, cloud-role change, or paid resource by itself.

## Target matrix

| Target | Signed candidate | Preview pointer | Stable pointer | Canary environment |
| --- | --- | --- | --- | --- |
| `macos-arm64` | Developer ID DMG and updater ZIP | `desktop/macos/arm64/beta-mac.yml` | `desktop/macos/arm64/latest-mac.yml` | Physical or remote Apple Silicon Mac |
| `macos-x64` | Developer ID DMG and updater ZIP | `desktop/macos/x64/beta-mac.yml` | `desktop/macos/x64/latest-mac.yml` | GitHub `macos-15-intel`; physical Intel Mac remains stronger final proof |
| `windows-x64` | Azure Artifact Signing NSIS installer | `desktop/windows/x64/beta.yml` | `desktop/windows/x64/latest.yml` | Interactive Windows 11 Azure Virtual Desktop |

All three targets for a version come from one commit. Preview publication and Stable promotion happen independently per target.

## One-time Windows signing setup

The intended Azure resources are:

- Artifact Signing account: `relayercodesigning`
- Region endpoint: `https://eus.codesigning.azure.net/`
- Public Trust certificate profile: `relayer-public-trust`
- GitHub environment: `desktop-production-windows`
- GitHub repository: `vishaltandale00/relayer-graphcomplete`

An Artifact Signing identity verifier must submit and complete the organization's legal identity validation before the Public Trust profile can be created. The GitHub workload identity then needs only `Artifact Signing Certificate Profile Signer` at the certificate-profile scope. Its federated credential is restricted to:

```text
subject: repo:vishaltandale00@9222298/relayer-graphcomplete@1327816644:environment:desktop-production-windows
audience: api://AzureADTokenExchange
issuer: https://token.actions.githubusercontent.com
```

This repository was created after GitHub's immutable-subject cutoff, so the
owner and repository numeric IDs are part of every default OIDC `sub` claim.
Do not replace this value with the legacy name-only subject.

Set these non-secret variables on `desktop-production-windows` after the profile and workload identity exist:

```text
AZURE_TENANT_ID
AZURE_CLIENT_ID
AZURE_SUBSCRIPTION_ID
RELAYER_WINDOWS_CERTIFICATE_PROFILE=relayer-public-trust
RELAYER_WINDOWS_PUBLISHER_NAME=<exact validated certificate publisher>
```

The Windows job uses the pinned official Azure login action to exchange GitHub's environment-bound OIDC assertion for a short-lived Azure CLI session. Electron-builder's Artifact Signing module consumes that session. No Azure client secret or exported signing certificate belongs in GitHub.

## Update publication authority

The protected `desktop-update-preview` environment supplies the existing update bucket and Preview AWS role. Before publishing Intel or Windows, inspect that role's current policy and extend it only as needed for these exact namespaces:

```text
desktop/macos/arm64/*
desktop/macos/x64/*
desktop/windows/x64/*
private/history/{macos-arm64,macos-x64,windows-x64}/*
private/receipts/{macos-arm64,macos-x64,windows-x64}/*
```

The Stable role needs read access to each target's immutable Preview objects and write access only to Stable history, receipts, and target-specific `latest*.yml` pointers. Retain the existing bucket, encryption, checksum, source-commit metadata, and conditional-write restrictions.

The reviewable least-privilege S3 and immutable-subject trust policies live in [`infra/aws/desktop-release-authority`](../infra/aws/desktop-release-authority/README.md). Inspect the live roles before applying them; the policy files do not authorize an AWS login or IAM change.

## GitHub release authority

Before the first Intel or Windows publication, activate the reviewed rulesets in [`infra/github/desktop-release-authority`](../infra/github/desktop-release-authority/README.md). They require pull requests and the `check` job for `main`, prevent force pushes and deletion, and restrict `desktop-v*` tag creation, replacement, and deletion to repository administrators.

Run the read-only live audit before every release-control change and before creating a release tag:

```sh
npm run desktop:release:audit-authority
```

The audit checks environment branch policies, required Apple secret names, required Azure variable names, AWS OIDC variable names, the immutable GitHub OIDC subject prefix, and active branch/tag rules. It reads names only and never prints secret or variable values. A failure is a release blocker, not permission to weaken the workflow or audit.

## Candidate and Preview sequence

1. Merge reviewed release changes to `main`.
2. Increment `desktop/package.json` to one numeric version shared by all targets.
3. Run `npm run check` and `npm run build` from the exact commit.
4. Run `Desktop Signed Preview Candidates` manually to prove all three signing jobs without publication.
5. Review every release receipt and installer signature.
6. Create `desktop-vX.Y.Z` on that exact `main` commit only after explicit publication approval.
7. The tagged workflow publishes immutable artifacts for each target and moves each Preview pointer last.

### First Intel and Windows rollout

Intel macOS and Windows do not yet have an older published Preview that can seed an updater canary. The initial rollout therefore needs two reviewed versions:

1. Publish `0.2.6` as the bootstrap Preview for all three targets after signing and artifact review.
2. Bump only the desktop version to `0.2.7`, rerun the full signed-candidate workflow, and publish it as the target Preview.
3. Exercise `0.2.6` to `0.2.7` on native Intel macOS and interactive Windows 11.
4. Commit the sealed canary evidence and promote `0.2.7` independently for each target.

Do not promote the bootstrap version to Stable. Existing Apple Silicon Preview `0.2.5` and Stable `0.2.4` remain valid independent feed history.

The manual run cannot publish. The tag run rejects a tag/version mismatch and a commit outside `origin/main`.

## Intel macOS canary

After both an older Intel Preview seed and a newer Intel Preview target are published, run `Intel macOS Desktop Preview Canary` with both versions, full source commits, and signed-candidate workflow run IDs.

The native `macos-15-intel` job:

- verifies both DMG hashes against their release receipts;
- validates Developer ID signatures, notarization tickets, Gatekeeper acceptance, and Intel-only executable architecture;
- mounts and launches the exact target DMG as first-install proof;
- installs the older seed, drives the real packaged updater through Preview, and observes relaunch into the target in a new process;
- seals available, ready, and post-update screenshots plus the updater JSONL trace against the immutable Preview publication receipt.

The runner temporarily places the isolated canary profile and evidence-log paths in the per-user launch environment. This preserves them when Squirrel relaunches through LaunchServices; the script restores any prior values before it exits.

The hosted runner proves native Intel packaging and updater behavior. It does not replace a physical Intel Mac check for release-critical hardware or user-specific security software.

## Windows 11 interactive canary

Use a personal Windows 11 Azure Virtual Desktop rather than a headless CI runner. Assign an eligible Microsoft 365 or Windows license to the test identity, use a small x64 session host, enable automatic shutdown/deallocation, and keep the desktop unavailable from the public internet except through Azure Virtual Desktop.

The reviewable deployment definition and fail-closed post-deployment scripts live in [`infra/azure/desktop-canary`](../infra/azure/desktop-canary/README.md). They create no resources by themselves. The test identity must authenticate natively as an Entra member in the Relayer tenant, not merely have Member permissions on an external B2B identity. The VM uses the system-assigned identity required by `AADLoginForWindows`, and the separate Windows Cloud Login script enables and verifies the tenant-level RDP authentication prerequisite. Supply the temporary local-administrator password only at deployment time.

The minimal deployment profile is:

| Setting | Required value |
| --- | --- |
| Host pool | Personal, direct assignment, one session host |
| Identity | Microsoft Entra joined with single sign-on enabled |
| Image | Windows 11 Enterprise multi-session, 24H2 or newer |
| Session host | `Standard_D2as_v5` (2 vCPU, 8 GiB) or a region-equivalent x64 size |
| OS disk | 128 GiB Standard SSD (`E10 LRS`) |
| Network | Dedicated VNet/subnet, no public IP, no public inbound ports |
| Access | Assign the test identity to the Desktop application group and VM User Login role |
| Cost guard | Start VM on Connect; automatic shutdown; manually deallocate after every canary |

Do not create the host pool until the user-access license is assigned and the Azure subscription owner has approved the billable VM and retained-disk costs. The test-only template uses Azure's ephemeral default outbound access so the single VM can reach required AVD, activation, update, and artifact endpoints without a continuously billed NAT Gateway. It creates no public-IP resource and no public inbound route. Do not reuse that outbound design for production workloads.

Start VM on Connect is enabled only after the host pool exists. Its post-deployment step assigns the `Desktop Virtualization Power On Off Contributor` role to the Azure Virtual Desktop service principal at subscription scope, as Microsoft requires, then directly assigns the one healthy session host to the test user. Review that role assignment with `-WhatIf` before applying it. The Azure Virtual Desktop control plane does not replace the per-user license requirement.

On the signed-in desktop, install Git, Node 22, and GitHub CLI, then check out the exact reviewed repository commit. Download the seed candidate, target candidate, and target publication receipt from their signed workflow runs:

```powershell
gh run download <seed-run-id> --name relayer-desktop-preview-windows-x64-<seed-commit> --dir seed
gh run download <target-run-id> --name relayer-desktop-preview-windows-x64-<target-commit> --dir target
gh run download <target-run-id> --name relayer-desktop-preview-publication-windows-x64-<target-commit> --dir publication
```

Run the interactive canary from an ordinary user PowerShell session:

```powershell
powershell -ExecutionPolicy Bypass -File desktop/release/run-windows-canary.ps1 `
  -SeedInstaller seed\Relayer-<seed>-win-x64.exe `
  -SeedReleaseReceipt seed\Relayer-<seed>-win-x64-RELEASE.json `
  -TargetInstaller target\Relayer-<target>-win-x64.exe `
  -TargetReleaseReceipt target\Relayer-<target>-win-x64-RELEASE.json `
  -PreviewPublicationReceipt publication\preview-publication-windows-x64-<target>.json `
  -EvidenceDirectory evidence
```

The script verifies exact hashes, publisher, timestamped Authenticode signatures, first installation, visible launch, an older seed installation, Preview discovery, monotonic download, ready state, restart, a new target process, target version, final signature, and hashed screenshots. The operator must explicitly confirm Windows accepted the first installer and must expose the final Settings state before capture. A silent or headless Windows job is not acceptable Stable-promotion evidence.

## Stable promotion

Review the generated JSON and screenshots before committing them under `docs/prd/assets/evidence/desktop/`. Then run `Promote Relayer Desktop to Stable` for one target with:

```text
target: <target key>
version: X.Y.Z
canary_evidence: <repository-relative JSON path>
confirmation: promote-<target key>-X.Y.Z
```

Promotion revalidates the committed evidence, immutable Preview receipt, historical manifest, and every public artifact byte. It moves only that target's Stable pointer and never rebuilds or re-signs the application.
