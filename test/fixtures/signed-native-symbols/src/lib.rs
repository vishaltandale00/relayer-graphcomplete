extern "C" { fn native_first(x: i32) -> i32; fn native_second(x: i32) -> i32; }
#[inline(never)]
pub fn rust_fixture(x: i32) -> i32 { unsafe { native_first(x) + native_second(x) } }
