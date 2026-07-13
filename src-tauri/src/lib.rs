mod native_bridge;

pub use native_bridge::{NativeBridge, NativeHealth};
use tauri::Manager;

#[tauri::command]
async fn get_native_health(engine: tauri::State<'_, NativeBridge>) -> Result<NativeHealth, String> {
    engine.health().await
}

pub fn register_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![get_native_health])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register_commands(
        tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .setup(|app| {
                let bridge = NativeBridge::launch_sidecar(app.handle());
                app.manage(bridge);
                Ok(())
            }),
    )
    .run(tauri::generate_context!())
    .expect("failed to run KeyFinder");
}
