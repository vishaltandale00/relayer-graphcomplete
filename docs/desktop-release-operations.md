# Desktop release operations

This runbook covers the operator-controlled steps around the code-owned release contract in [ADR 0002](decisions/0002-desktop-release-contract.md). It does not authorize a tag, publication, Stable promotion, cloud-role change, or paid resource by itself.

## Target matrix

| Target | Signed candidate | Preview pointer | Stable pointer | Canary environment |
| --- | --- | --- | --- | --- |
| `macos-arm64` | Developer ID DMG and updater ZIP | `desktop/macos/arm64/beta-mac.yml` | `desktop/macos/arm64/latest-mac.yml` | Physical or remote Apple Silicon Mac |
| `macos-x64` | Developer ID DMG and updater ZIP | `desktop/macos/x64/beta-mac.yml` | `desktop/macos/x64/latest-mac.yml` | GitHub `macos-15-intel`; physical Intel Mac remains stronger final proof |
| `windows-x64` | **Blocked; pipeline disabled.** Azure Artifact Signing NSIS installer is implemented but unverified. | `desktop/windows/x64/beta.yml` | `desktop/windows/x64/latest.yml` | Interactive Windows 11 Azure Virtual Desktop |

Enabled targets for a version come from one commit. Preview publication and Stable promotion happen independently per target. Windows is disabled until the exact publisher variable exists, Azure signing succeeds, and the interactive canary passes.

## Prime managed-runtime checkpoint

On macOS Apple Silicon, run `npm run test:prime-managed-runtime` from the exact
candidate commit before signed candidate work. It builds `prime@0.8.1` in a
clean temporary root, verifies the exact uv, CPython, and 78-wheel identities,
performs the offline assembly, copies the reviewed packaged JavaScript and
first-party Python trees, and runs the provider-free real-kernel probe. This is
deterministic assembly proof, not signing, notarization, update publication, or
paid inference. Issue #378 owns update metadata/publication and issue #379 owns
downloadable JavaScript reconstruction; do not infer either from this pass.

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

This default audit excludes the disabled Windows candidate. It still checks the existing Azure identity variables but does not require the missing publisher name. Before enabling the Windows candidate, run `npm run desktop:release:audit-authority -- --include-windows-candidate`. That mode requires every Windows variable. The selected audit mode must match the enabled workflow targets.

The audit checks environment branch policies, target-required secret and variable names, AWS OIDC variable names, the immutable GitHub OIDC subject prefix, and active branch/tag rules. It reads names only and never prints secret or variable values. A failure for an enabled target is a release blocker, not permission to weaken the workflow or audit.

## Candidate and Preview sequence

1. Merge reviewed release changes to `main`.
2. Increment `desktop/package.json` to one numeric version shared by all targets.
3. Run `npm run check` and `npm run build` from the exact commit.
4. Run `Desktop Signed Preview Candidates` manually to build the enabled signed candidates without publication. Each signed release receipt seals its producing workflow run ID and attempt. Record the run ID and attempt, plus each enabled target artifact's numeric ID and `sha256:` digest from the GitHub Actions artifact API. A target remains eligible when its package job and artifact succeed even if an independent sibling target fails.
5. Review every release receipt and installer signature from that manual run.
6. After explicit publication approval, create one protected annotated tag on that exact `main` commit. Pin the reviewed manual run in the annotation; do not choose it by recency:

   ```sh
   git tag -a desktop-vX.Y.Z <full-main-commit> \
     -m "Relayer Desktop X.Y.Z" \
     -m "Candidate-Run: <successful-manual-workflow-run-id>/<run-attempt>" \
     -m "Candidate-Artifact-macos-arm64: <artifact-id>/<sha256:digest>"
   ```

7. Push the tag once. The tagged workflow verifies that each pinned target job succeeded in the named manual attempt for the same `main` commit, resolves one unexpired artifact ID and SHA-256 digest per enabled target, downloads by that immutable artifact ID, and matches the run and attempt sealed inside the signed release receipt before publication. It does not rebuild, re-sign, re-notarize, rerun repository checks, or re-upload telemetry. The publisher records the candidate run, attempt, artifact ID, and artifact digest; it revalidates the release receipt, checksums, artifact bytes, existing immutable publication receipt, and public objects before moving the Preview pointer last.

A lightweight tag, a malformed or repeated `Candidate-Run` annotation, or a run from another attempt, workflow, event, repository, branch, commit, or artifact set fails closed. Never move or recreate a tag to repair that failure. If the tag annotation is wrong, leave the tag and version unpublished and prepare a new version. A workflow retry is valid only while it remains pinned to the same candidate run attempt and artifact identity; immutable-object and publication-receipt checks still reject different bytes.

### First Intel rollout

Intel macOS initially lacked an older compliant signed-DMG Preview that could seed an updater canary. Workflow `32334546660` published Apple Silicon `0.2.7`, but Intel packaging failed after successful signing and notarization. Electron-builder used `desktop/dist/mac/Relayer.app`; the release finalizer expected `desktop/dist/mac-x64/Relayer.app`. Intel `0.2.7` therefore has no sealed artifact or Preview receipt.

1. Fix and verify the Intel application output path.
2. Treat `0.2.8` and `0.2.9` as non-promotable because their DMG containers lack Developer ID signatures.
3. Publish `0.2.10` as the signed-DMG Intel bootstrap Preview.
4. Publish `0.2.11` as the signed-DMG Intel target Preview.
5. Exercise the `0.2.10` to `0.2.11` update on native Intel macOS.
6. Commit the sealed canary evidence. Obtain separate action-time approval before promoting the Intel target.

This rollout completed with native canary workflow `32350071508` and Stable promotion workflow `32372106406`. The protected promotion reused the exact `0.2.11` Preview bytes.

Do not promote the bootstrap version to Stable. Apple Silicon Preview `0.2.9` and Stable `0.2.4` remain valid independent feed history; `0.2.7` is the historical first target-aware Apple Silicon candidate. The immutable `desktop-v0.2.6` tag predates the target-aware publisher and is not an Intel or Windows bootstrap candidate.

### Windows rollout blocker

The Windows workflow path is implemented but disabled. Use this sequence:

1. Complete identity validation and set the exact `RELAYER_WINDOWS_PUBLISHER_NAME` value.
2. Enable only the Windows candidate job and run the Windows-inclusive authority audit.
3. Run the manual workflow and verify the Azure-signed installer and receipt. Manual runs cannot publish.
4. Add Windows Preview publication and publish two new reviewed Windows versions.
5. Prove the bootstrap-to-target update in the interactive Windows 11 AVD session.
6. Allow Windows Stable promotion only after the committed canary evidence passes review.

The manual run cannot publish. The tag run rejects a tag/version mismatch and a commit outside `origin/main`.

## Native macOS canaries

After both an older Preview seed and a newer Preview target are published for the same macOS architecture, run the target-specific workflow with both versions and full source commits. Supply the seed candidate run, the target's pinned manual candidate run, and the target's tagged publication run separately. The target candidate artifact exists only in the manual run; the target publication receipt exists only in the tagged run.

- `Apple Silicon macOS Desktop Preview Canary` runs on `macos-15` and consumes only `macos-arm64` artifacts and receipts.
- `Intel macOS Desktop Preview Canary` runs on `macos-15-intel` and consumes only `macos-x64` artifacts and receipts.

Each native job:

- verifies both DMG hashes against their release receipts;
- validates Developer ID signatures, notarization tickets, Gatekeeper acceptance, and the target's executable architecture;
- mounts and launches the exact target DMG as first-install proof;
- installs the older seed, drives the real packaged updater through Preview, and observes relaunch into the target in a new process;
- seals available, ready, and post-update screenshots plus the updater JSONL trace against the immutable Preview publication receipt.

The runner temporarily places the isolated canary profile and evidence-log paths in the per-user launch environment. This preserves them when Squirrel relaunches through LaunchServices; the script restores any prior values before it exits.

The hosted runner proves native packaging and updater behavior for its target. It does not replace a physical-device check for release-critical hardware or user-specific security software.

Apple Silicon workflow `32399053432` completed the exact `0.2.10` to `0.2.11` Preview update on native arm64 macOS. Its committed evidence is under `docs/prd/assets/evidence/desktop/macos-arm64-0.2.10-to-0.2.11/`. Protected workflow `32399976404` later promoted the same `0.2.11` bytes to Stable.

Workflows `32443697093` and `32443698408` completed the exact `0.2.11` to `0.2.12` Preview update on native Apple Silicon and Intel macOS. Their committed evidence is under `docs/prd/assets/evidence/desktop/macos-arm64-0.2.11-to-0.2.12/` and `docs/prd/assets/evidence/desktop/macos-x64-0.2.11-to-0.2.12/`. Protected workflows `32444315112` and `32444318263` later promoted the exact Apple Silicon and Intel Preview bytes to Stable.

Workflows `32534359978` and `32534361604` completed the exact `0.2.12` to `0.2.13` Preview update on native Apple Silicon and Intel macOS. Their committed evidence is under `docs/prd/assets/evidence/desktop/macos-arm64-0.2.12-to-0.2.13/` and `docs/prd/assets/evidence/desktop/macos-x64-0.2.12-to-0.2.13/`. Protected workflows `32535131928` and `32535133480` later promoted the exact Apple Silicon and Intel Preview bytes to Stable.

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

On the signed-in desktop, install Git and GitHub CLI, then check out the exact reviewed repository commit and install the Node version recorded in `.node-version` at that commit. Do not install "latest Node 22": this procedure reproduces a signed build, and the release workflows resolve their Node from that file, so any other version verifies something the pipeline never produced. Download the seed candidate, target candidate, and target publication receipt from their signed workflow runs:

```powershell
gh run download <seed-run-id> --name relayer-desktop-preview-windows-x64-<seed-commit> --dir seed
gh run download <target-candidate-run-id> --name relayer-desktop-preview-windows-x64-<target-commit> --dir target
gh run download <target-publication-run-id> --name relayer-desktop-preview-publication-windows-x64-<target-commit> --dir publication
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
