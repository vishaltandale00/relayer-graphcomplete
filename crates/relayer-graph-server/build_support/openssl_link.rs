// Shared by `build.rs` and `tests/openssl_link.rs` through `include!`, so the
// library-naming rule the packaging build used to own stays under test after
// moving into the build script. An included file cannot carry inner doc comments.

/// How the OpenSSL archives are meant to be linked. A prepared prefix is
/// static-only, so a packaged binary carries no OpenSSL dylib or rpath; an
/// ordinary developer or CI build links whatever OpenSSL the machine has.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Linkage {
    Static,
    Dynamic,
}

/// MSVC names the static archives `libssl`/`libcrypto`; every other target drops
/// the prefix.
fn openssl_library_names(linkage: Linkage, msvc: bool) -> [String; 2] {
    ["ssl", "crypto"].map(|library| match linkage {
        Linkage::Static if msvc => format!("static=lib{library}"),
        Linkage::Static => format!("static={library}"),
        Linkage::Dynamic => library.to_owned(),
    })
}
