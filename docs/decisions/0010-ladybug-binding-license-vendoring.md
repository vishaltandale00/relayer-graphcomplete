# ADR 0010: Vendor the Ladybug binding MIT license with upstream provenance

Status: accepted

## Context

The desktop build links the `lbug` 0.18.0 Rust binding, whose `Cargo.toml` declares
`license = "MIT"` but whose published crates.io archive ships no license file. The crate's
`include` allowlist omits `LICENSE`, and it uses SPDX `license = "MIT"` rather than
`license-file`, so Cargo never injects one. This was verified across `0.18.3`, `0.19.1`,
`0.20.0`, and `0.20.1` — every archive after the upstream license commit still lacks the
file. MIT's condition requires the copyright and permission notice to be reproduced in
distributions, so the compiled binding could not be shipped on the manifest declaration alone.

The release gate blocked on `lbug-binding-missing-upstream-license-file` until reviewed
upstream license bytes or an explicit legal disposition existed. In response to that request,
the rights holder added a top-level MIT `LICENSE` to `LadybugDB/ladybug-rust` in commit
`7afc780e` (2026-08-28, by the crates.io publisher), and closed the upstream issue. The text
names two holders: Kùzu Inc. (2022-2025) and Ladybug Memory Inc. (2025-2026). The vendored
core license names only Kùzu, so it cannot substitute for the binding.

## Decision

Vendor the upstream `LICENSE` verbatim as the binding notice instead of waiting for a crate
release that will never carry it. Pin provenance to the rights holder's exact commit, not the
mutable `main` branch:

- upstream repository `LadybugDB/ladybug-rust`, commit
  `7afc780e33fb42c8f9b2f0c4ab6833bf2f86c76f`;
- git blob `9bb12b2468f7629dd9a6ce15d4d972ad014ff40d`;
- file SHA-256 `1c495c9546d0de02e83c9d50d5f7eb21f0085bc8f77a0ee333081a123a9c8d0c`.

The notice is recorded using the repository's existing httplib-style pattern for a notice not
drawn from the pinned tree: `noticeProvenance` carrying the commit-pinned URL plus SHA-256, with
the digest also entered in `noticeSha256`. The binding receipt status becomes
`upstream-license-vendored`. `bindingArchiveContainsLicenseFile` stays `false`: the pinned
archive genuinely still omits the file, and the grant is the manifest's `license = "MIT"` while
the vendored `LICENSE` supplies the notice text that grant requires be reproduced.

The native receipt verifier must digest-check the binding notice like every other notice. Its
`licensePaths` set previously covered only core, OpenSSL, and native components, which is the
structural hole that let the gate pass with `licensePath: null`. The binding notice path is
added so a missing or mutated binding notice fails verification.

Packaging bundles `vendor/ladybug/notices/` to `notices/ladybug` and asserts the bundle after
packing: the main desktop package verifies every inventoried notice is present with its pinned
digest and that no unlisted file shipped, and the Eval package runs the same shared bundle check
with Prime Agent verification scoped out (it carries the compiled Ladybug graph server but not
the Prime Agent runtime). The PRD
already promises the build "verifies that the .app contains … licenses", so bundling is not a
new product decision; it needs the `afterPack` check to make the promise true.

## Consequences

- The `lbug-binding-missing-upstream-license-file` blocker is retired and the distribution
  license receipts are release-ready on reviewed upstream license bytes.
- The binding notice is held to the same digest discipline as the core, OpenSSL, and
  transitive native notices.
- The main desktop package and the Eval package each ship the complete Ladybug notice set and
  verify it at pack time (present + exact digest + no unlisted files); a build that drops a
  notice fails at pack time rather than shipping without required text.
- Upstream remains authoritative for the license text; Relayer records the exact commit, blob,
  and content digest so the vendored bytes stay auditable against the rights holder.
- A future crate release that finally ships the same `LICENSE` can adopt it without changing
  this decision, because the grant and notice text are identical.
