use serde_json::{Map, Value, json};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

const SETTINGS_FILE: &str = "settings-v1.json";
const SETTINGS_SCHEMA_VERSION: u64 = 2;

pub fn defaults() -> Value {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    json!({
        "schemaVersion": SETTINGS_SCHEMA_VERSION,
        "parallel": true,
        "bpmAnalysisEnabled": true,
        "maxDurationMinutes": 60,
        "skipExisting": false,
        "automaticWrites": false,
        "extensionFilterEnabled": false,
        "extensions": ["mp3", "m4a", "mp4", "wma", "flac", "aif", "aiff", "wav"],
        "outputs": {
            "title": "none", "artist": "none", "album": "none",
            "comment": "prepend", "grouping": "none",
            "initialKey": "none", "bpm": "none", "filename": "none"
        },
        "delimiter": " - ",
        "notation": "standard",
        "customCodes": vec![""; 25],
        "features": {
            "playlistsEnabled": false
        },
        "libraryPaths": {
            "itunes": format!("{home}/Music/iTunes/iTunes Music Library.xml"),
            "traktor": format!("{home}/Documents/Native Instruments/Traktor 2.7.1/collection.nml"),
            "serato": format!("{home}/Music/_Serato_/database V2")
        },
        "presentation": {
            "compactRows": false, "libraryOpen": true,
            "windowWidth": 1120, "windowHeight": 760
        },
        "legacyMigrationCompleted": false
    })
}

#[derive(Clone)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn from_app<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let path = app
            .path()
            .app_config_dir()
            .map(|directory| directory.join(SETTINGS_FILE))
            .map_err(|error| format!("Could not locate settings directory: {error}"))?;
        Ok(Self { path })
    }

    pub fn load(&self) -> Result<Value, String> {
        load_path(&self.path)
    }

    pub fn save(&self, settings: &Value) -> Result<(), String> {
        save_path(&self.path, settings)
    }
}

fn load_path(path: &PathBuf) -> Result<Value, String> {
    if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read settings: {error}"))?;
        let saved: Value = serde_json::from_str(&content)
            .map_err(|error| format!("Settings file is invalid: {error}"))?;
        let saved_version = saved
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .unwrap_or(1);
        let mut settings = merge(defaults(), saved);
        if saved_version < SETTINGS_SCHEMA_VERSION {
            // Automatic file writes must be explicitly enabled in this app.
            // Older settings may have inherited this dangerous preference from
            // the original KeyFinder installation.
            settings["schemaVersion"] = json!(SETTINGS_SCHEMA_VERSION);
            settings["automaticWrites"] = Value::Bool(false);
            save_path(path, &settings)?;
        }
        return Ok(settings);
    }

    let mut settings = defaults();
    migrate_legacy(&mut settings);
    settings["legacyMigrationCompleted"] = Value::Bool(true);
    save_path(path, &settings)?;
    Ok(settings)
}

fn save_path(path: &PathBuf, settings: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create settings directory: {error}"))?;
    }
    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize settings: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, format!("{content}\n"))
        .map_err(|error| format!("Could not write settings: {error}"))?;
    if cfg!(windows) && path.exists() {
        fs::remove_file(&path).map_err(|error| format!("Could not replace settings: {error}"))?;
    }
    fs::rename(&temporary, &path).map_err(|error| format!("Could not save settings: {error}"))
}

fn merge(default: Value, saved: Value) -> Value {
    match (default, saved) {
        (Value::Object(mut base), Value::Object(overrides)) => {
            for (key, value) in overrides {
                let previous = base.remove(&key).unwrap_or(Value::Null);
                base.insert(key, merge(previous, value));
            }
            Value::Object(base)
        }
        (_, saved) if !saved.is_null() => saved,
        (default, _) => default,
    }
}

fn set_path(settings: &mut Value, path: &[&str], value: Value) {
    let mut current = settings;
    for key in &path[..path.len() - 1] {
        current = current
            .as_object_mut()
            .expect("default settings paths are objects")
            .entry((*key).to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    current[path[path.len() - 1]] = value;
}

fn mode(value: i64) -> &'static str {
    match value {
        1 => "prepend",
        2 => "append",
        3 => "overwrite",
        _ => "none",
    }
}

fn notation(value: i64) -> &'static str {
    match value {
        1 => "custom",
        2 => "combined",
        _ => "standard",
    }
}

#[cfg(target_os = "macos")]
fn migrate_legacy(settings: &mut Value) {
    use plist::Value as PlistValue;

    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let preferences = PathBuf::from(home).join("Library/Preferences");
    let candidates = [
        preferences.join("uk.co.ibrahimshaath.KeyFinder.plist"),
        preferences.join("co.uk.ibrahimshaath.KeyFinder.plist"),
        preferences.join("Ibrahim Sha'ath.KeyFinder.plist"),
    ];
    let Some(path) = candidates.iter().find(|path| path.exists()) else {
        return;
    };
    let Ok(root) = PlistValue::from_file(path) else {
        return;
    };
    let get = |key: &str| plist_lookup(&root, key).cloned();

    for (legacy, target) in [
        ("batch/parallelBatchJobs", &["parallel"][..]),
        ("batch/skipFilesWithExistingTags", &["skipExisting"][..]),
        (
            "batch/applyFileExtensionFilter",
            &["extensionFilterEnabled"][..],
        ),
    ] {
        if let Some(value) = get(legacy).and_then(|value| value.as_boolean()) {
            set_path(settings, target, Value::Bool(value));
        }
    }
    if let Some(value) = get("batch/maxDuration").and_then(|value| value.as_signed_integer()) {
        set_path(settings, &["maxDurationMinutes"], json!(value));
    }
    if let Some(value) = get("tags/metadataDelimiter").and_then(|value| value.into_string()) {
        set_path(settings, &["delimiter"], json!(value));
    }
    if let Some(value) = get("tags/metadataFormat").and_then(|value| value.as_signed_integer()) {
        set_path(settings, &["notation"], json!(notation(value)));
    }
    if let Some(value) = get("batch/filterFileExtensions") {
        let extensions = match value {
            PlistValue::Array(values) => values
                .into_iter()
                .filter_map(PlistValue::into_string)
                .collect::<Vec<_>>(),
            PlistValue::String(value) => value
                .split([',', ';'])
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        };
        if !extensions.is_empty() {
            set_path(settings, &["extensions"], json!(extensions));
        }
    }
    for (legacy, field) in [
        ("metadataWriteTitle", "title"),
        ("metadataWriteArtist", "artist"),
        ("metadataWriteAlbum", "album"),
        ("metadataWriteComment", "comment"),
        ("metadataWriteGrouping", "grouping"),
        ("metadataWriteKey", "initialKey"),
        ("metadataWriteFilename", "filename"),
    ] {
        let key = format!("tags/{legacy}");
        if let Some(value) = get(&key).and_then(|value| value.as_signed_integer()) {
            set_path(settings, &["outputs", field], json!(mode(value)));
        }
    }
    for (legacy, field) in [
        ("iTunesLibraryPath", "itunes"),
        ("traktorLibraryPath", "traktor"),
        ("seratoLibraryPath", "serato"),
    ] {
        let key = format!("library/{legacy}");
        if let Some(value) = get(&key).and_then(|value| value.into_string()) {
            set_path(settings, &["libraryPaths", field], json!(value));
        }
    }
    let names = [
        "A", "Am", "Bb", "Bbm", "B", "Bm", "C", "Cm", "Db", "Dbm", "D", "Dm", "Eb", "Ebm", "E",
        "Em", "F", "Fm", "Gb", "Gbm", "G", "Gm", "Ab", "Abm", "SLNC",
    ];
    let mut codes = vec![String::new(); names.len()];
    for (index, name) in names.iter().enumerate() {
        if let Some(value) =
            get(&format!("customKeyCodes/{name}")).and_then(|value| value.into_string())
        {
            codes[index] = value;
        }
    }
    set_path(settings, &["customCodes"], json!(codes));
}

#[cfg(target_os = "macos")]
fn plist_lookup<'a>(root: &'a plist::Value, key: &str) -> Option<&'a plist::Value> {
    let dictionary = root.as_dictionary()?;
    if let Some(value) = dictionary.get(key) {
        return Some(value);
    }
    let mut current = root;
    for component in key.split('/') {
        current = current.as_dictionary()?.get(component)?;
    }
    Some(current)
}

#[cfg(target_os = "linux")]
fn migrate_legacy(settings: &mut Value) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let path = PathBuf::from(home).join(".config/Ibrahim Sha'ath/KeyFinder.conf");
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let values = parse_ini(&content);
    apply_flat_legacy(settings, |key| values.get(key).cloned());
}

#[cfg(windows)]
fn migrate_legacy(settings: &mut Value) {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = root.open_subkey("Software\\Ibrahim Sha'ath\\KeyFinder") else {
        return;
    };
    apply_flat_legacy(settings, |name| {
        let (group, field) = name.split_once('/')?;
        let group = key.open_subkey(group).ok()?;
        group
            .get_value::<String, _>(field)
            .ok()
            .or_else(|| {
                group
                    .get_value::<u32, _>(field)
                    .ok()
                    .map(|value| value.to_string())
            })
            .or_else(|| {
                group
                    .get_value::<i32, _>(field)
                    .ok()
                    .map(|value| value.to_string())
            })
    });
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn migrate_legacy(_settings: &mut Value) {}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn apply_flat_legacy(settings: &mut Value, get: impl Fn(&str) -> Option<String>) {
    let boolean =
        |value: String| matches!(value.to_ascii_lowercase().as_str(), "true" | "1" | "yes");
    for (legacy, target) in [
        ("batch/parallelBatchJobs", &["parallel"][..]),
        ("batch/skipFilesWithExistingTags", &["skipExisting"][..]),
        (
            "batch/applyFileExtensionFilter",
            &["extensionFilterEnabled"][..],
        ),
    ] {
        if let Some(value) = get(legacy) {
            set_path(settings, target, Value::Bool(boolean(value)));
        }
    }
    if let Some(value) = get("batch/maxDuration").and_then(|value| value.parse::<u64>().ok()) {
        set_path(settings, &["maxDurationMinutes"], json!(value));
    }
    if let Some(value) = get("tags/metadataDelimiter") {
        set_path(settings, &["delimiter"], json!(value));
    }
    if let Some(value) = get("tags/metadataFormat").and_then(|value| value.parse::<i64>().ok()) {
        set_path(settings, &["notation"], json!(notation(value)));
    }
    for (legacy, field) in [
        ("metadataWriteTitle", "title"),
        ("metadataWriteArtist", "artist"),
        ("metadataWriteAlbum", "album"),
        ("metadataWriteComment", "comment"),
        ("metadataWriteGrouping", "grouping"),
        ("metadataWriteKey", "initialKey"),
        ("metadataWriteFilename", "filename"),
    ] {
        if let Some(value) =
            get(&format!("tags/{legacy}")).and_then(|value| value.parse::<i64>().ok())
        {
            set_path(settings, &["outputs", field], json!(mode(value)));
        }
    }
    for (legacy, field) in [
        ("iTunesLibraryPath", "itunes"),
        ("traktorLibraryPath", "traktor"),
        ("seratoLibraryPath", "serato"),
    ] {
        if let Some(value) = get(&format!("library/{legacy}")) {
            set_path(settings, &["libraryPaths", field], json!(value));
        }
    }
    let names = [
        "A", "Am", "Bb", "Bbm", "B", "Bm", "C", "Cm", "Db", "Dbm", "D", "Dm", "Eb", "Ebm", "E",
        "Em", "F", "Fm", "Gb", "Gbm", "G", "Gm", "Ab", "Abm", "SLNC",
    ];
    let codes = names
        .iter()
        .map(|name| get(&format!("customKeyCodes/{name}")).unwrap_or_default())
        .collect::<Vec<_>>();
    if codes.iter().any(|code| !code.is_empty()) {
        set_path(settings, &["customCodes"], json!(codes));
    }
    if let Some(value) = get("batch/filterFileExtensions") {
        let extensions = value
            .trim_matches(|character| matches!(character, '[' | ']'))
            .split([',', ';'])
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !extensions.is_empty() {
            set_path(settings, &["extensions"], json!(extensions));
        }
    }
}

#[cfg(target_os = "linux")]
fn parse_ini(content: &str) -> std::collections::HashMap<String, String> {
    let mut section = String::new();
    let mut values = std::collections::HashMap::new();
    for line in content.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].to_owned();
        } else if let Some((key, value)) = line.split_once('=') {
            values.insert(format!("{section}/{}", key.trim()), value.trim().to_owned());
        }
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_settings_merge_with_new_defaults() {
        let merged = merge(
            defaults(),
            json!({"parallel": false, "outputs": {"comment": "append"}}),
        );
        assert_eq!(merged["parallel"], false);
        assert_eq!(merged["bpmAnalysisEnabled"], true);
        assert_eq!(merged["outputs"]["comment"], "append");
        assert_eq!(merged["outputs"]["title"], "none");
        assert_eq!(merged["outputs"]["bpm"], "none");
        assert_eq!(merged["maxDurationMinutes"], 60);
        assert_eq!(merged["features"]["playlistsEnabled"], false);
        assert_eq!(merged["presentation"]["libraryOpen"], true);
    }

    #[test]
    fn flat_legacy_settings_cover_behavior_and_library_paths() {
        let values = std::collections::HashMap::from([
            ("tags/writeToFilesAutomatically", "true"),
            ("tags/metadataFormat", "2"),
            ("tags/metadataWriteKey", "3"),
            ("batch/maxDuration", "45"),
            ("batch/filterFileExtensions", "mp3, flac"),
            ("customKeyCodes/A", "8B"),
            ("library/traktorLibraryPath", "/music/collection.nml"),
        ]);
        let mut migrated = defaults();
        apply_flat_legacy(&mut migrated, |key| {
            values.get(key).map(|value| (*value).to_owned())
        });
        assert_eq!(migrated["automaticWrites"], false);
        assert_eq!(migrated["notation"], "combined");
        assert_eq!(migrated["outputs"]["initialKey"], "overwrite");
        assert_eq!(migrated["maxDurationMinutes"], 45);
        assert_eq!(migrated["extensions"], json!(["mp3", "flac"]));
        assert_eq!(migrated["customCodes"][0], "8B");
        assert_eq!(migrated["libraryPaths"]["traktor"], "/music/collection.nml");
    }

    #[test]
    fn schema_upgrade_disables_inherited_automatic_writes() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("neo-keyfinder-settings-{suffix}"));
        let path = directory.join(SETTINGS_FILE);
        save_path(
            &path,
            &json!({
                "schemaVersion": 1,
                "automaticWrites": true,
                "outputs": { "comment": "prepend" }
            }),
        )
        .expect("legacy settings fixture should save");

        let upgraded = load_path(&path).expect("legacy settings should upgrade");
        assert_eq!(upgraded["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        assert_eq!(upgraded["automaticWrites"], false);
        let persisted: Value = serde_json::from_str(
            &fs::read_to_string(&path).expect("upgraded settings should persist"),
        )
        .expect("upgraded settings should remain valid JSON");
        assert_eq!(persisted["automaticWrites"], false);
        let _ = fs::remove_dir_all(directory);
    }
}
