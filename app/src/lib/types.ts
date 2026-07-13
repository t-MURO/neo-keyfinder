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
  durationMs: number | null;
  detectedKey: number | null;
  detectedCode: string;
  status: TrackStatus;
  error: TrackError | null;
}

export type OutputMode = "none" | "prepend" | "append" | "overwrite";
export type NotationMode = "standard" | "custom" | "combined";

export interface Settings {
  schemaVersion: number;
  parallel: boolean;
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
    filename: OutputMode;
  };
  delimiter: string;
  notation: NotationMode;
  customCodes: string[];
  libraryPaths: {
    itunes: string;
    traktor: string;
    serato: string;
  };
  presentation: {
    compactRows: boolean;
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

export interface NativeEvent {
  version: number;
  event: "trackUpdated" | "trackProgress" | "jobProgress" | "jobFinished";
  jobId: string;
  sequence: number;
  payload: Record<string, unknown>;
}

