fn main() {
    println!(
        "cargo:rustc-env=TARGET={}",
        std::env::var("TARGET").expect("Cargo should provide TARGET")
    );
    tauri_build::build()
}
