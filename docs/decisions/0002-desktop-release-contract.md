# ADR 0002: Relayer Desktop release identity and candidate contract

Status: accepted

## Decision

Relayer Desktop ships directly for Apple Silicon and Intel on macOS 13 or newer and for Windows x64. The production application is `Relayer` with application ID `ai.relayer.desktop`; unsigned local packages use `Relayer Dev` and `ai.relayer.desktop.development` so they can coexist safely.

The first production release is `0.2.0`. Desktop versions use numeric `major.minor.patch` syntax. Preview and Stable are channels for the same signed application, not prerelease version suffixes or separately signed products. Each target has independent pointers and immutable artifacts:

- Apple Silicon: `desktop/macos/arm64/{beta-mac.yml,latest-mac.yml,releases/...}`
- Intel macOS: `desktop/macos/x64/{beta-mac.yml,latest-mac.yml,releases/...}`
- Windows x64: `desktop/windows/x64/{beta.yml,latest.yml,releases/...}`

All targets for a version are built from the same source commit. A target may be promoted only from its own verified Preview bytes and target-specific canary evidence.

Every signed candidate is built from a clean Git commit and includes its source commit, version, target, channel, update URL, and signing identity in sealed package metadata and a release receipt. macOS production packaging requires the Developer ID Application identity for team `NZ253AL7U6` and complete Apple notarization credentials; a notarized DMG is the first-install artifact and a notarized ZIP is the update artifact. Windows production packaging requires the `relayercodesigning` Azure Artifact Signing account, a Public Trust certificate profile, and a GitHub OIDC identity holding only the certificate-profile signer role; the signed NSIS executable is both the first-install and update artifact.

Unsigned artifacts are never published. Preview publication writes immutable versioned artifacts before `beta-mac.yml`. Stable promotion reuses the exact verified Preview artifact and changes only `latest-mac.yml`; it never rebuilds or re-signs the candidate.

The signed-candidate workflow may be run manually from `main` without changing the feed. Preview publication requires a matching `desktop-vX.Y.Z` tag on a commit contained by `origin/main`, the protected `desktop-update-preview` GitHub environment, and short-lived AWS credentials obtained through GitHub OIDC. The publisher accepts exactly one sealed artifact set, rejects a downgrade or same-version byte replacement, verifies immutable public bytes before moving the pointer, and uses conditional S3 writes so concurrent publishers cannot silently win. A retry may reuse only byte-identical objects and the original immutable publication receipt.

## Consequences

- The original `0.1.0` Relayer build and the new desktop share product continuity; `0.2.0` is the first new signed seed and `0.2.1` is the first update proof.
- Preview and Stable cannot be installed side by side, while `Relayer Dev` can coexist with either.
- A Preview user cannot downgrade to an older Stable version. Stable promotion therefore follows a successful Preview canary and uses monotonically increasing numeric versions.
- macOS 12-or-older and Windows Arm support require separate release decisions and validation.
- Intel macOS is built and canaried on GitHub's `macos-15-intel` runner while that hosted x64 environment remains available; a physical Intel Mac remains the strongest final hardware check.
- Windows Stable promotion requires an interactive-session canary proving installer signature, installation, visible application launch, Preview discovery, installation, and signed relaunch into the exact candidate.
- A target with incomplete signing authority remains disabled. It does not block another target. Preview needs proven signing; Stable additionally needs target canary evidence.
- A bad release is withdrawn before further installation or repaired by publishing a newer version. Relayer does not automatically downgrade application code because a future older binary may not understand newer local data.
- Recovery from a failed local-data schema migration belongs to the future persistence contract, where the schema and transaction boundary can be tested. It is not an updater acceptance criterion before that persistence layer exists.
- The updater UI and publication pipeline consume this contract; they do not redefine release identity or channel semantics.
- A tag is publication authority, not merely a version label. Deleting or recreating a tag cannot overwrite immutable artifacts for that version.
