//! `lbug` links a static C++ archive whose extension installer calls OpenSSL, but
//! the crate's own Cargo build metadata omits the OpenSSL link directives. Supply
//! them from here rather than from `RUSTFLAGS`, which applies to the whole build
//! graph and invalidates its cache.

use std::{env, path::PathBuf, process::Command};

include!("build_support/openssl_link.rs");

fn main() {
    println!("cargo:rerun-if-env-changed=OPENSSL_DIR");
    println!("cargo:rerun-if-env-changed=OPENSSL_LIB_DIR");
    // A build script is compiled without its own crate's features, so the feature
    // has to be read from the environment rather than through `cfg!`.
    if env::var_os("CARGO_FEATURE_LADYBUG").is_none() {
        return;
    }
    let (library_directory, linkage) = openssl_prefix();
    println!(
        "cargo:rustc-link-search=native={}",
        library_directory.display()
    );
    let msvc = env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    for library in openssl_library_names(linkage, msvc) {
        println!("cargo:rustc-link-lib={library}");
    }
}

/// Resolve the directory holding `libssl`/`libcrypto`, and how to link them. A
/// prepared prefix wins, so a packaged build never silently picks up a system
/// OpenSSL its receipts do not cover.
fn openssl_prefix() -> (PathBuf, Linkage) {
    if let Some(directory) = env::var_os("OPENSSL_LIB_DIR") {
        return (PathBuf::from(directory), Linkage::Static);
    }
    if let Some(directory) = env::var_os("OPENSSL_DIR") {
        return (PathBuf::from(directory).join("lib"), Linkage::Static);
    }
    if let Some(directory) = pkg_config_library_directory() {
        return (directory, Linkage::Dynamic);
    }
    for candidate in ["/opt/homebrew/opt/openssl@3", "/usr/local/opt/openssl@3"] {
        let directory = PathBuf::from(candidate).join("lib");
        if directory.is_dir() {
            return (directory, Linkage::Dynamic);
        }
    }
    panic!(
        "the ladybug feature needs OpenSSL to link. Set OPENSSL_DIR to a prefix \
         containing lib/, install OpenSSL 3 so pkg-config can find it, or build \
         with --no-default-features to compile Ladybug out."
    );
}

fn pkg_config_library_directory() -> Option<PathBuf> {
    let output = Command::new("pkg-config")
        .args(["--variable=libdir", "openssl"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let directory = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    directory.is_dir().then_some(directory)
}
