import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { AppInfo, NativeEvent, PlaylistResult, ScanWarning, Settings, Track } from "./types";

export interface NativeHealth {
  service: "keyfinder-native";
  engineVersion: string;
  protocolVersion: number;
}

export async function getNativeHealth(): Promise<NativeHealth> {
  return invoke<NativeHealth>("get_native_health");
}

export async function loadSettings(): Promise<Settings> {
  return invoke<Settings>("load_settings");
}

export async function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}

export async function pickAudioFiles(): Promise<string[]> {
  return invoke<string[]>("pick_audio_files");
}

export async function pickAudioFolder(): Promise<string | null> {
  return invoke<string | null>("pick_audio_folder");
}

export async function expandFiles(
  paths: string[],
  settings: Settings,
): Promise<{ tracks: Track[]; warnings: ScanWarning[] }> {
  return invoke("expand_files", { paths, settings });
}

export async function startAnalysis(
  tracks: Track[],
  settings: Settings,
): Promise<{ jobId: string }> {
  return invoke("start_analysis", { tracks, settings, owner: getCurrentWebview().label });
}

export async function cancelAnalysis(
  jobId: string,
): Promise<{ cancelled: boolean }> {
  return invoke("cancel_analysis", { jobId });
}

export async function writeTracks(
  tracks: Track[],
  settings: Settings,
): Promise<{ tracks: Track[] }> {
  return invoke("write_tracks", { tracks, settings });
}

export async function discoverLibraries(settings: Settings): Promise<PlaylistResult> {
  return invoke("discover_libraries", { settings });
}

export async function loadPlaylist(path: string): Promise<PlaylistResult> {
  return invoke("load_playlist", { path });
}

export async function pickPlaylistFile(): Promise<string | null> {
  return invoke<string | null>("pick_playlist_file");
}

export async function newBatchWindow(): Promise<string> {
  return invoke<string>("new_batch_window");
}

export async function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("get_app_info");
}

export async function openProjectUrl(url: string): Promise<void> {
  return invoke("open_project_url", { url });
}

export function listenMenuActions(handler: (action: string) => void): Promise<UnlistenFn> {
  return listen<string>("menu-action", ({ payload }) => handler(payload));
}

export function listenNativeEvents(
  handler: (event: NativeEvent) => void,
): Promise<UnlistenFn> {
  return listen<NativeEvent>("native-event", ({ payload }) => handler(payload));
}

export function listenForFileDrops(
  handler: (paths: string[]) => void,
  setHovering: (hovering: boolean) => void,
): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "over") setHovering(true);
    if (payload.type === "leave") setHovering(false);
    if (payload.type === "drop") {
      setHovering(false);
      handler(payload.paths);
    }
  });
}
