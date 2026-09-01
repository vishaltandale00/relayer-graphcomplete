# Ladybug source-build inputs

`source-build-manifest.json` is the authority for the native graph-search dependency inputs. It
pins the exact crates.io `lbug` archive, the reviewed Ladybug 0.18.0 core embedded in that archive,
OpenSSL 3.5.8 source, the zero-extension v1 profile, and the no-fork build mode.

Source acquisition and source preparation are deliberately separate:

```sh
npm run ladybug:source -- fetch --cache /absolute/cache/directory
npm run ladybug:source -- verify --cache /absolute/cache/directory
npm run ladybug:source -- prepare --cache /absolute/cache/directory \
  --output /absolute/empty/build/directory \
  --target aarch64-apple-darwin
```

`fetch` is the only network-using command. `verify`, `stage`, and `prepare` consume local archives
and fail on missing or mismatched bytes. `prepare` builds static-only OpenSSL, writes
`source-receipt.json`, and emits `cargo-build-env.json`. Before denying network access, Cargo must
fetch the workspace's locked Rust dependency closure. The subsequent Rust build must use
`--locked --offline`, the emitted environment, unset every name in `environmentMustBeUnset`, and
use an operating-system or CI network-denial boundary for release evidence. In particular, ambient
`LBUG_LIBRARY_DIR`/`LBUG_INCLUDE_DIR` values would otherwise bypass the reviewed source build.

The emitted environment asks the unmodified `lbug` 0.18.0 binding to build its embedded core in
static mode. That binding does not emit OpenSSL link directives. Relayer therefore owns the narrow,
target-specific adapter frozen in the manifest: `ssl`/`crypto` on Apple targets and
`libssl`/`libcrypto` on MSVC, all resolved from `openssl-prefix/lib`. The adapter changes no Ladybug
source and admits no extensions. The result carries Ladybug and OpenSSL inside the Rust executable;
no Ladybug/OpenSSL dylib or Ladybug rpath is packaged. Final packaging must still verify each
target's imports rather than inferring this result from the build configuration.

The source receipt is complete for distribution licensing. The crates.io binding archive declares
MIT but ships no binding license file, so the binding notice is vendored from the upstream
`LadybugDB/ladybug-rust` MIT `LICENSE` at commit `7afc780e` (git blob `9bb12b24…`, SHA-256
`1c495c95…`). The core, OpenSSL, binding, and transitive native notices are inventoried in
`native-inventory.json` with their provenance and digests. Packaging must still bundle
`vendor/ladybug/notices/` and verify the bundle before shipping.
