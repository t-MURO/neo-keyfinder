mod native_bridge;
mod settings;

pub use native_bridge::{NativeBridge, NativeHealth};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{LogicalSize, Manager, WindowEvent};

#[tauri::command]
async fn get_native_health(engine: tauri::State<'_, NativeBridge>) -> Result<NativeHealth, String> {
    engine.health().await
}

#[tauri::command]
async fn expand_files(
    paths: Vec<String>,
    settings: Value,
    engine: tauri::State<'_, NativeBridge>,
) -> Result<Value, String> {
    engine
        .call(
            "expandFiles",
            json!({"paths": paths, "settings": settings}),
            Duration::from_secs(120),
        )
        .await
}

#[tauri::command]
async fn start_analysis(
    tracks: Value,
    settings: Value,
    engine: tauri::State<'_, NativeBridge>,
) -> Result<Value, String> {
    engine
        .call(
            "startAnalysis",
            json!({"tracks": tracks, "settings": settings}),
            Duration::from_secs(10),
        )
        .await
}

#[tauri::command]
async fn cancel_analysis(
    job_id: String,
    engine: tauri::State<'_, NativeBridge>,
) -> Result<Value, String> {
    engine
        .call(
            "cancelJob",
            json!({"jobId": job_id}),
            Duration::from_secs(5),
        )
        .await
}

#[tauri::command]
async fn write_tracks(
    tracks: Value,
    settings: Value,
    engine: tauri::State<'_, NativeBridge>,
) -> Result<Value, String> {
    engine
        .call(
            "writeTracks",
            json!({"tracks": tracks, "settings": settings}),
            Duration::from_secs(120),
        )
        .await
}

#[tauri::command]
async fn load_settings(store: tauri::State<'_, settings::Store>) -> Result<Value, String> {
    store.load()
}

#[tauri::command]
async fn save_settings(
    store: tauri::State<'_, settings::Store>,
    settings: Value,
) -> Result<(), String> {
    store.save(&settings)
}

#[tauri::command]
async fn pick_audio_files() -> Result<Vec<String>, String> {
    let files = rfd::AsyncFileDialog::new()
        .set_title("Add audio files")
        .add_filter(
            "Audio files",
            &["mp3", "m4a", "mp4", "wma", "flac", "aif", "aiff", "wav"],
        )
        .pick_files()
        .await;
    Ok(files
        .unwrap_or_default()
        .into_iter()
        .map(|file| file.path().to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
async fn pick_audio_folder() -> Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("Add a folder")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned()))
}

pub fn register_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        get_native_health,
        expand_files,
        start_analysis,
        cancel_analysis,
        write_tracks,
        load_settings,
        save_settings,
        pick_audio_files,
        pick_audio_folder
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register_commands(
        tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .setup(|app| {
                let bridge = NativeBridge::launch_sidecar(app.handle());
                app.manage(bridge);
                let settings_store =
                    settings::Store::from_app(app.handle()).map_err(std::io::Error::other)?;
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(saved) = settings_store.load()
                        && let Some(presentation) = saved.get("presentation")
                        && let (Some(width), Some(height)) = (
                            presentation.get("windowWidth").and_then(Value::as_f64),
                            presentation.get("windowHeight").and_then(Value::as_f64),
                        )
                    {
                        let _ = window.set_size(LogicalSize::new(width, height));
                    }
                    let close_store = settings_store.clone();
                    let close_window = window.clone();
                    window.on_window_event(move |event| {
                        if !matches!(event, WindowEvent::CloseRequested { .. }) {
                            return;
                        }
                        let Ok(size) = close_window.inner_size() else {
                            return;
                        };
                        let Ok(scale) = close_window.scale_factor() else {
                            return;
                        };
                        let logical = size.to_logical::<f64>(scale);
                        let Ok(mut saved) = close_store.load() else {
                            return;
                        };
                        saved["presentation"]["windowWidth"] = json!(logical.width);
                        saved["presentation"]["windowHeight"] = json!(logical.height);
                        let _ = close_store.save(&saved);
                    });
                }
                app.manage(settings_store);
                Ok(())
            }),
    )
    .run(tauri::generate_context!())
    .expect("failed to run KeyFinder");
}
