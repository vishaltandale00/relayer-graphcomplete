use std::{env, process::Command};
fn main() {
    let out = env::var("OUT_DIR").unwrap();
    for name in ["first", "second"] {
        assert!(Command::new("clang")
            .args(["-g", "-c", &format!("{name}.c"), "-o", &format!("{out}/{name}.o")])
            .status().unwrap().success());
    }
    assert!(Command::new("ar")
        .args(["crs", &format!("{out}/liblbug.a"), &format!("{out}/first.o"), &format!("{out}/second.o")])
        .status().unwrap().success());
    println!("cargo:rustc-link-search=native={out}");
    println!("cargo:rustc-link-lib=static=lbug");
}
