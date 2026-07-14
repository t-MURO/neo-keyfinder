import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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

export async function prepareAudioPlayback(path: string): Promise<string> {
  const canonicalPath = await invoke<string>("prepare_audio_playback", { path });
  return convertFileSrc(canonicalPath);
}

export async function revealTrackInFolder(path: string): Promise<void> {
  return invoke("reveal_audio_file", { path });
}

const waveformCache = new Map<string, Promise<number[]>>();

export async function getAudioWaveform(path: string, points = 180): Promise<number[]> {
  const cacheKey = `${path}\0${points}`;
  const cached = waveformCache.get(cacheKey);
  if (cached) return cached;
  const request = invoke<{ peaks: number[] }>("get_audio_waveform", { path, points })
    .then(({ peaks }) => peaks.map((peak) => Math.max(0, Math.min(1, Number(peak) || 0))))
    .catch((error) => {
      waveformCache.delete(cacheKey);
      throw error;
    });
  waveformCache.set(cacheKey, request);
  return request;
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
  writeAuthorization = false,
): Promise<{ jobId: string }> {
  return invoke("start_analysis", { tracks, settings, owner: getCurrentWebview().label, writeAuthorization });
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
