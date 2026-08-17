fn main() {
    println!("cargo:rerun-if-changed=src/storage/sqlite/migrations");
}
