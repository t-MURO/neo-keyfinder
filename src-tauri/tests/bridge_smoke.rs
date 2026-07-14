use neo_keyfinder_lib::{NativeBridge, NativeHealth, register_commands};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tauri::ipc::InvokeBody;
use tauri::webview::InvokeRequest;

fn sidecar_path() -> PathBuf {
    if let Some(path) = std::env::var_os("KEYFINDER_NATIVE_BIN") {
        return PathBuf::from(path);
    }

    let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let prefix = format!("keyfinder-native-{}", env!("TARGET"));
    std::fs::read_dir(&binaries)
        .expect("sidecar directory should exist")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == prefix || name == format!("{prefix}.exe"))
        })
        .unwrap_or_else(|| panic!("run `npm run native:build` before this test"))
}

#[test]
fn frontend_ipc_reaches_tauri_and_the_native_sidecar() {
    let bridge = NativeBridge::launch_executable(&sidecar_path());
    let app = register_commands(tauri::test::mock_builder().manage(bridge))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock Tauri app should build");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("mock frontend webview should build");

    let response = tauri::test::get_ipc_response(
        &webview,
        InvokeRequest {
            cmd: "get_native_health".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .expect("valid local Tauri URL"),
            body: InvokeBody::Json(json!({})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .expect("typed command should succeed")
    .deserialize::<NativeHealth>()
    .expect("frontend response should match its TypeScript contract");

    assert_eq!(response.service, "keyfinder-native");
    assert_eq!(response.engine_version, "0.1.0");
    assert_eq!(response.protocol_version, 1);

    let temporary =
        std::env::temp_dir().join(format!("neo-keyfinder-bridge-write-{}", std::process::id()));
    std::fs::create_dir_all(&temporary).expect("temporary write directory should exist");
    let audio = temporary.join("bpm.mp3");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../is_KeyFinder/test-resources/readTags/mp3 with id3 v2.4.mp3");
    std::fs::copy(fixture, &audio).expect("MP3 fixture should be copied");
    let settings = json!({
        "outputs": {
            "comment": "none",
            "bpm": "overwrite"
        }
    });
    let track = json!({
        "id": "bridge-bpm",
        "path": audio,
        "filename": "bpm.mp3",
        "detectedKey": null,
        "detectedBpm": 128.4,
        "status": "completed"
    });
    let written = tauri::test::get_ipc_response(
        &webview,
        InvokeRequest {
            cmd: "write_tracks".into(),
            callback: tauri::ipc::CallbackFn(2),
            error: tauri::ipc::CallbackFn(3),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .expect("valid local Tauri URL"),
            body: InvokeBody::Json(json!({"tracks": [track], "settings": settings})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .expect("BPM write command should succeed")
    .deserialize::<Value>()
    .expect("BPM write response should be valid JSON");
    assert_eq!(written["tracks"][0]["initialBpm"], 128.0);
    assert!(written["tracks"][0]["error"].is_null());

    let rescanned = tauri::test::get_ipc_response(
        &webview,
        InvokeRequest {
            cmd: "expand_files".into(),
            callback: tauri::ipc::CallbackFn(4),
            error: tauri::ipc::CallbackFn(5),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .expect("valid local Tauri URL"),
            body: InvokeBody::Json(json!({"paths": [audio], "settings": settings})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .expect("written MP3 should rescan")
    .deserialize::<Value>()
    .expect("scan response should be valid JSON");
    assert_eq!(rescanned["tracks"][0]["initialBpm"], 128.0);
    std::fs::remove_dir_all(temporary).expect("temporary write directory should be removed");
}
