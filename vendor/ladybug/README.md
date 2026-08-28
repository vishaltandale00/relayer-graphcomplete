# Ladybug source-build inputs

`source-build-manifest.json` is the authority for the native graph-search dependency inputs. It
pins the exact crates.io `lbug` archive, the reviewed Ladybug 0.19.1 core embedded in that archive,
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

The emitted environment asks the unmodified `lbug` 0.19.1 binding to build its embedded core in
static mode. Upstream 0.19.1 describes the OpenSSL link to Cargo as `dylib`, which becomes ordinary
`-lssl -lcrypto` arguments on macOS. `LIBRARY_PATH` is therefore pinned to the static-only OpenSSL
prefix so the linker resolves those names to the reviewed archives. The result carries Ladybug and
OpenSSL inside the Rust executable; no Ladybug/OpenSSL dylib or Ladybug rpath is packaged. Final
packaging must still verify each target's imports rather than inferring this result from the build
configuration.

The source receipt also remains explicitly incomplete for distribution licensing. The crates.io
binding archive declares MIT but contains no binding license file. The core, OpenSSL, and
transitive native notices are inventoried separately in `native-inventory.json`; its remaining
binding-license blocker must be resolved before packaging.
