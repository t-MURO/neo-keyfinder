# Integration tests

The milestone-one IPC smoke test lives in `src-tauri/tests/bridge_smoke.rs`
because it needs Tauri's Rust mock runtime. This directory is reserved for the
later desktop end-to-end suite and its fixtures.
