mod native_bridge;
mod settings;

pub use native_bridge::{NativeBridge, NativeHealth};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, LogicalSize, Manager, WebviewUrl, WindowEvent};
use tauri_plugin_opener::OpenerExt;

static NEXT_WINDOW_ID: AtomicU64 = AtomicU64::new(1);
const PROJECT_URL: &str = "https://github.com/t-MURO/neo-keyfinder";

struct DesktopApp(tauri::AppHandle);

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
    owner: String,
    write_authorization: bool,
    engine: tauri::State<'_, NativeBridge>,
) -> Result<Value, String> {
    engine
        .call(
            "startAnalysis",
            json!({
                "tracks": tracks,
                "settings": settings,
                "owner": owner,
                "writeAuthorization": write_authorization
            }),
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
async fn discover_libraries(
    settings: Value,
    engine: tauri::State<'_, NativeBridge>,
) -> Result<Value, String> {
    engine
        .call(
            "discoverLibraries",
            json!({"settings": settings}),
            Duration::from_secs(120),
        )
        .await
}

#[tauri::command]
async fn load_playlist(
    path: String,
    engine: tauri::State<'_, NativeBridge>,
) -> Result<Value, String> {
    engine
        .call(
            "loadPlaylist",
            json!({"path": path}),
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
async fn pick_audio_folders() -> Result<Vec<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("Add folders")
        .pick_folders()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|folder| folder.path().to_string_lossy().into_owned())
        .collect())
}

fn is_supported_audio_file(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("mp3" | "m4a" | "mp4" | "wma" | "flac" | "aif" | "aiff" | "wav")
    )
}

fn canonical_audio_path(path: &str) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("Could not open the audio file: {error}"))?;
    if !canonical.is_file() || !is_supported_audio_file(&canonical) {
        return Err("Only supported audio files can be opened.".into());
    }
    Ok(canonical)
}

#[tauri::command]
fn prepare_audio_playback(
    desktop: tauri::State<'_, DesktopApp>,
    path: String,
) -> Result<String, String> {
    let canonical = canonical_audio_path(&path)?;
    desktop
        .0
        .asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|error| format!("Could not authorize audio playback: {error}"))?;
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
fn reveal_audio_file(desktop: tauri::State<'_, DesktopApp>, path: String) -> Result<(), String> {
    let canonical = canonical_audio_path(&path)?;
    desktop
        .0
        .opener()
        .reveal_item_in_dir(&canonical)
        .map_err(|error| format!("Could not reveal the audio file: {error}"))
}

#[tauri::command]
async fn get_audio_waveform(
    path: String,
    points: u32,
    engine: tauri::State<'_, NativeBridge>,
) -> Result<Value, String> {
    let canonical = canonical_audio_path(&path)?;
    engine
        .call(
            "generateWaveform",
            json!({"path": canonical.to_string_lossy(), "points": points}),
            Duration::from_secs(120),
        )
        .await
}

#[tauri::command]
async fn pick_playlist_file() -> Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("Import a playlist")
        .add_filter("Supported playlists", &["m3u", "m3u8", "xml"])
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned()))
}

fn create_batch_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<String, String> {
    let label = format!("batch-{}", NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed));
    tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("NeoKeyAndBpmFinder")
        .inner_size(1120.0, 760.0)
        .min_inner_size(560.0, 560.0)
        .center()
        .build()
        .map_err(|error| format!("Could not open a batch window: {error}"))?;
    Ok(label)
}

#[tauri::command]
async fn new_batch_window(app: tauri::State<'_, DesktopApp>) -> Result<String, String> {
    create_batch_window(&app.0)
}

#[tauri::command]
fn get_app_info() -> Value {
    json!({
        "name": "NeoKeyAndBpmFinder",
        "version": env!("CARGO_PKG_VERSION"),
        "projectUrl": PROJECT_URL,
        "releaseApiUrl": format!("{PROJECT_URL}/releases/latest"),
        "releaseMetadataUrl": "https://api.github.com/repos/t-MURO/neo-keyfinder/releases/latest"
    })
}

#[tauri::command]
fn open_project_url(app: tauri::State<'_, DesktopApp>, url: String) -> Result<(), String> {
    if url != PROJECT_URL && !url.starts_with(&format!("{PROJECT_URL}/")) {
        return Err("Only NeoKeyAndBpmFinder project links can be opened".into());
    }
    app.0
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|error| format!("Could not open the link: {error}"))
}

fn emit_menu_action<R: tauri::Runtime>(app: &tauri::AppHandle<R>, action: &str) {
    if let Some((label, _)) = app
        .webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
    {
        let _ = app.emit_to(label, "menu-action", action);
    }
}

fn install_menu<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .text("new-batch", "New Batch Window")
        .separator()
        .item(&settings)
        .separator()
        .close_window()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .text("check-updates", "Check for Updates…")
        .text("about-keyfinder", "About NeoKeyAndBpmFinder")
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &window, &help])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn register_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        get_native_health,
        expand_files,
        start_analysis,
        cancel_analysis,
        write_tracks,
        discover_libraries,
        load_playlist,
        load_settings,
        save_settings,
        pick_audio_files,
        pick_audio_folders,
        prepare_audio_playback,
        reveal_audio_file,
        get_audio_waveform,
        pick_playlist_file,
        new_batch_window,
        get_app_info,
        open_project_url
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    register_commands(
        tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_opener::init())
            .on_menu_event(|app, event| match event.id().as_ref() {
                "new-batch" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = create_batch_window(&app);
                    });
                }
                "settings" => emit_menu_action(app, "settings"),
                "check-updates" => emit_menu_action(app, "check-updates"),
                "about-keyfinder" => emit_menu_action(app, "about"),
                _ => {}
            })
            .setup(|app| {
                install_menu(app)?;
                let bridge = NativeBridge::launch_sidecar(app.handle());
                app.manage(bridge);
                app.manage(DesktopApp(app.handle().clone()));
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
    .expect("failed to run NeoKeyAndBpmFinder");
}
