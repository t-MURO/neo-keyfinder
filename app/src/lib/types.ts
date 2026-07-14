export type TrackStatus =
  | "pending"
  | "reading"
  | "ready"
  | "skipped"
  | "analyzing"
  | "completed"
  | "failed"
  | "cancelled";

export interface TrackError {
  code: string;
  stage: string;
  message: string;
}

export interface Track {
  id: string;
  path: string;
  filename: string;
  title: string;
  artist: string;
  album: string;
  comment: string;
  grouping: string;
  initialKey: string;
  initialBpm: number | null;
  durationMs: number | null;
  detectedKey: number | null;
  detectedCode: string;
  detectedBpm: number | null;
  status: TrackStatus;
  error: TrackError | null;
}

export type OutputMode = "none" | "prepend" | "append" | "overwrite";
export type NotationMode = "standard" | "custom" | "combined" | "djCombined";

export interface Settings {
  schemaVersion: number;
  parallel: boolean;
  bpmAnalysisEnabled: boolean;
  maxDurationMinutes: number;
  skipExisting: boolean;
  automaticWrites: boolean;
  extensionFilterEnabled: boolean;
  extensions: string[];
  outputs: {
    title: OutputMode;
    artist: OutputMode;
    album: OutputMode;
    comment: OutputMode;
    grouping: OutputMode;
    initialKey: OutputMode;
    bpm: OutputMode;
    filename: OutputMode;
  };
  delimiter: string;
  notation: NotationMode;
  customCodes: string[];
  features: {
    playlistsEnabled: boolean;
  };
  libraryPaths: {
    itunes: string;
    traktor: string;
    serato: string;
  };
  presentation: {
    compactRows: boolean;
    libraryOpen: boolean;
    windowWidth: number;
    windowHeight: number;
  };
  legacyMigrationCompleted: boolean;
}

export interface ScanWarning {
  path: string;
  code: string;
  message: string;
}

export type PlaylistSource = "itunes" | "traktor" | "serato" | "m3u";

export interface Playlist {
  id: string;
  name: string;
  source: PlaylistSource;
  origin: string;
  tracks: string[];
  readOnly: true;
}

export interface PlaylistWarning {
  source: string;
  path: string;
  code: string;
  message: string;
}

export interface PlaylistResult {
  playlists: Playlist[];
  warnings: PlaylistWarning[];
}

export interface AppInfo {
  name: string;
  version: string;
  projectUrl: string;
  releaseApiUrl: string;
  releaseMetadataUrl: string;
}

export interface NativeEvent {
  version: number;
  event: "trackUpdated" | "trackProgress" | "jobProgress" | "jobFinished";
  jobId: string;
  owner?: string;
  sequence: number;
  payload: Record<string, unknown>;
}
