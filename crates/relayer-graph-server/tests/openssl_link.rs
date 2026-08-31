//! Keeps the OpenSSL library-naming rule under test after it moved out of
//! `desktop/packaging/build-development.mjs` and into the build script.

include!("../build_support/openssl_link.rs");

#[test]
fn a_prepared_prefix_links_statically_under_each_target_naming_rule() {
    assert_eq!(
        openssl_library_names(Linkage::Static, false),
        ["static=ssl", "static=crypto"]
    );
    assert_eq!(
        openssl_library_names(Linkage::Static, true),
        ["static=libssl", "static=libcrypto"]
    );
}

#[test]
fn a_system_openssl_links_dynamically_without_the_msvc_archive_prefix() {
    assert_eq!(
        openssl_library_names(Linkage::Dynamic, false),
        ["ssl", "crypto"]
    );
    assert_eq!(
        openssl_library_names(Linkage::Dynamic, true),
        ["ssl", "crypto"]
    );
}
