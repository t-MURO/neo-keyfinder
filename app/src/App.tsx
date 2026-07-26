import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  cancelAnalysis,
  discoverLibraries,
  expandFiles,
  getAppInfo,
  getAudioWaveform,
  getNativeHealth,
  listenForFileDrops,
  listenMenuActions,
  listenNativeEvents,
  loadPlaylist,
  loadSettings,
  newBatchWindow,
  openProjectUrl,
  pickAudioFolders,
  pickAudioFiles,
  pickPlaylistFile,
  prepareAudioPlayback,
  revealTrackInFolder,
  saveSettings,
  startAnalysis,
  writeTracks,
  type NativeHealth,
} from "./lib/native-engine";
import { translate as t } from "./lib/i18n";
import type {
  AppInfo,
  NativeEvent,
  OutputMode,
  Playlist,
  PlaylistWarning,
  Settings,
  Track,
} from "./lib/types";

const KEY_NAMES = [
  "A", "Am", "Bb", "Bbm", "B", "Bm", "C", "Cm", "Db", "Dbm", "D", "Dm",
  "Eb", "Ebm", "E", "Em", "F", "Fm", "Gb", "Gbm", "G", "Gm", "Ab", "Abm", "Silence",
];

const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 2,
  parallel: true,
  bpmAnalysisEnabled: true,
  maxDurationMinutes: 60,
  skipExisting: false,
  automaticWrites: false,
  extensionFilterEnabled: false,
  extensions: ["mp3", "m4a", "mp4", "wma", "flac", "aif", "aiff", "wav"],
  outputs: {
    title: "none",
    artist: "none",
    album: "none",
    comment: "prepend",
    grouping: "none",
    initialKey: "none",
    bpm: "none",
    filename: "none",
  },
  delimiter: " - ",
  notation: "standard",
  customCodes: Array.from({ length: 25 }, () => ""),
  features: { playlistsEnabled: false },
  libraryPaths: { itunes: "", traktor: "", serato: "" },
  presentation: { compactRows: false, libraryOpen: true, windowWidth: 1120, windowHeight: 760 },
  legacyMigrationCompleted: false,
};

type EngineState =
  | { kind: "checking" }
  | { kind: "available"; health: NativeHealth }
  | { kind: "unavailable"; message: string };
type SortKey = keyof Pick<
  Track,
  "filename" | "title" | "artist" | "album" | "comment" | "grouping" | "initialKey" | "initialBpm" | "detectedBpm" | "detectedCode"
>;
type SortState = { key: SortKey; direction: 1 | -1 } | null;

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "The operation could not be completed.";
}

function mergeTracks(current: Track[], incoming: Track[]): Track[] {
  const byPath = new Map(current.map((track) => [track.path, track]));
  for (const track of incoming) {
    if (!byPath.has(track.path)) byPath.set(track.path, track);
  }
  return [...byPath.values()];
}

function orderTracks(tracks: Track[], sort: SortState): Track[] {
  if (!sort) return tracks;
  return [...tracks].sort((a, b) => {
    const left = a[sort.key];
    const right = b[sort.key];
    if (typeof left === "number" && typeof right === "number") {
      return (left - right) * sort.direction;
    }
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return String(left).localeCompare(String(right), undefined, {
      numeric: true,
      sensitivity: "base",
    }) * sort.direction;
  });
}

function SidebarIcon() {
  return (
    <svg className="sidebar-toggle-icon" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="3" width="15" height="14" rx="2" />
      <path d="M7.5 3v14" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg className="application-menu-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 5.25h14M3 10h14M3 14.75h14" />
    </svg>
  );
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return (
    <svg className="media-volume-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.25 8h3l3.5-3v10l-3.5-3h-3z" />
      {muted ? (
        <path d="m13 8 4 4m0-4-4 4" />
      ) : (
        <>
          <path d="M12.5 7.3a3.6 3.6 0 0 1 0 5.4" />
          <path d="M14.7 5.2a6.5 6.5 0 0 1 0 9.6" />
        </>
      )}
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="table-search-icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="m12.2 12.2 4.1 4.1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="media-close-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.5 5.5 9 9m0-9-9 9" />
    </svg>
  );
}

function AddFilesIcon() {
  return (
    <svg className="add-source-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 2.75h6l4 4v10.5H5z" />
      <path d="M11 2.75v4h4M10 9.5v5M7.5 12h5" />
    </svg>
  );
}

function AddFolderIcon() {
  return (
    <svg className="add-source-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.75 5.25h5l1.5 1.75h8v9.25H2.75z" />
      <path d="M10 9.5v4.5M7.75 11.75h4.5" />
    </svg>
  );
}

function trackMatchesFilter(track: Track, filter: string): boolean {
  const terms = filter.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const searchable = [
    track.filename,
    track.path,
    track.title,
    track.artist,
    track.album,
    track.comment,
    track.grouping,
    track.initialKey,
    track.initialBpm,
    track.detectedKey,
    track.detectedCode,
    track.detectedBpm,
    track.status,
    track.error?.code,
    track.error?.stage,
    track.error?.message,
  ].filter((value) => value !== null && value !== undefined).join(" ").toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}

function formatBpm(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";
}

function hasWritableResult(track: Track, settings: Settings): boolean {
  const keyOutputEnabled = Object.entries(settings.outputs)
    .some(([field, mode]) => field !== "bpm" && mode !== "none");
  const bpmOutputEnabled = settings.outputs.bpm !== "none";
  return (keyOutputEnabled && track.detectedKey !== null)
    || (bpmOutputEnabled && track.detectedBpm !== null);
}

function revealTrackLabel(): string {
  const platform = navigator.userAgent.toLocaleLowerCase();
  if (platform.includes("windows")) return "Show in Explorer";
  if (platform.includes("linux")) return "Show in file manager";
  return "Show in Finder";
}

function ApplicationMenu({
  engineUnavailable,
  onRetryEngine,
  onNewWindow,
  onSettings,
  onCheckUpdates,
  onAbout,
}: {
  engineUnavailable: boolean;
  onRetryEngine: () => void;
  onNewWindow: () => void;
  onSettings: () => void;
  onCheckUpdates: () => void;
  onAbout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="application-menu" ref={rootRef}>
      <button
        className="icon-button application-menu-toggle"
        type="button"
        aria-label={open ? "Close application menu" : "Open application menu"}
        aria-haspopup="menu"
        aria-expanded={open}
        ref={toggleRef}
        onClick={() => setOpen((current) => !current)}
      >
        <MenuIcon />
      </button>
      {open && (
        <div className="application-menu-popover" role="menu" aria-label="Application actions">
          <button type="button" role="menuitem" onClick={() => run(onNewWindow)}>New window</button>
          {engineUnavailable && <button type="button" role="menuitem" onClick={() => run(onRetryEngine)}>Retry engine</button>}
          <span role="separator" />
          <button type="button" role="menuitem" aria-keyshortcuts="Meta+, Control+," onClick={() => run(onSettings)}>Settings</button>
          <button type="button" role="menuitem" onClick={() => run(onCheckUpdates)}>Check for updates</button>
          <button type="button" role="menuitem" onClick={() => run(onAbout)}>About NeoKeyAndBpmFinder</button>
        </div>
      )}
    </div>
  );
}

function AddTracksMenu({
  disabled,
  onAddFiles,
  onAddFolders,
}: {
  disabled: boolean;
  onAddFiles: () => void;
  onAddFolders: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="add-tracks-menu" ref={rootRef}>
      <button
        className="add-tracks-toggle"
        type="button"
        aria-label="Add more songs"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        ref={toggleRef}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="add-tracks-plus" aria-hidden="true">+</span>
        <span>Add more songs</span>
      </button>
      {open && (
        <div className="add-tracks-popover" role="menu" aria-label="Add tracks">
          <button type="button" role="menuitem" onClick={() => run(onAddFiles)}>
            <AddFilesIcon />
            <span>Add files</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onAddFolders)}>
            <AddFolderIcon />
            <span>Add folders</span>
          </button>
        </div>
      )}
    </div>
  );
}

function SettingsPanel({
  value,
  onChange,
  onClose,
  onSave,
}: {
  value: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof Settings>(key: K, next: Settings[K]) =>
    onChange({ ...value, [key]: next });
  const setOutput = (key: keyof Settings["outputs"], mode: OutputMode) =>
    set("outputs", { ...value.outputs, [key]: mode });

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <p className="eyebrow">Preferences</p>
            <h2 id="settings-title">Analysis &amp; output</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close settings" onClick={onClose}>×</button>
        </header>

        <div className="settings-body">
          <fieldset>
            <legend>Processing</legend>
            <label className="toggle-row">
              <span><strong>Parallel analysis</strong><small>Use available CPU cores for batch jobs.</small></span>
              <input type="checkbox" checked={value.parallel} onChange={(event) => set("parallel", event.target.checked)} />
            </label>
            <label className="toggle-row">
              <span><strong>BPM analysis</strong><small>Detect tempo with Essentia while analyzing tracks.</small></span>
              <input type="checkbox" checked={value.bpmAnalysisEnabled} onChange={(event) => set("bpmAnalysisEnabled", event.target.checked)} />
            </label>
            <label className="toggle-row">
              <span><strong>Skip existing keys</strong><small>Skip files whose enabled outputs already contain a key.</small></span>
              <input type="checkbox" checked={value.skipExisting} onChange={(event) => set("skipExisting", event.target.checked)} />
            </label>
            <label className="toggle-row">
              <span><strong>Write automatically</strong><small>Apply configured outputs after each successful analysis.</small></span>
              <input type="checkbox" checked={value.automaticWrites} onChange={(event) => set("automaticWrites", event.target.checked)} />
            </label>
            <label className="field-row">
              <span>Maximum duration</span>
              <span className="input-with-unit">
                <input
                  aria-label="Maximum duration"
                  type="number"
                  min="1"
                  max="1440"
                  value={value.maxDurationMinutes}
                  onChange={(event) => set("maxDurationMinutes", Math.max(1, Number(event.target.value) || 1))}
                />
                <small>minutes</small>
              </span>
            </label>
          </fieldset>

          <fieldset>
            <legend>Experimental features</legend>
            <label className="toggle-row">
              <span><strong>Playlist libraries</strong><small>Show the read-only playlist browser and library integrations.</small></span>
              <input
                type="checkbox"
                checked={value.features.playlistsEnabled}
                onChange={(event) => set("features", { ...value.features, playlistsEnabled: event.target.checked })}
              />
            </label>
          </fieldset>

          {value.features.playlistsEnabled && (
            <fieldset>
              <legend>External libraries</legend>
              <p className="settings-note">Library playlists are browsed read-only. Enter the library file for iTunes and Traktor, and either the _Serato_ folder or its database V2 file for Serato.</p>
              {(["itunes", "traktor", "serato"] as const).map((source) => (
                <label className="stacked-field" key={source}>
                  {source === "itunes" ? "iTunes XML" : source === "traktor" ? "Traktor NML" : "Serato folder"}
                  <input
                    value={value.libraryPaths[source]}
                    placeholder={source === "serato" ? "/Music/_Serato_" : source === "traktor" ? "/Traktor/collection.nml" : "/Music/iTunes Library.xml"}
                    onChange={(event) => set("libraryPaths", { ...value.libraryPaths, [source]: event.target.value })}
                  />
                </label>
              ))}
            </fieldset>
          )}

          <fieldset>
            <legend>File intake</legend>
            <label className="toggle-row">
              <span><strong>Filter extensions</strong><small>Only scan the listed audio extensions.</small></span>
              <input type="checkbox" checked={value.extensionFilterEnabled} onChange={(event) => set("extensionFilterEnabled", event.target.checked)} />
            </label>
            <label className="stacked-field">
              Extensions, comma separated
              <input
                value={value.extensions.join(", ")}
                disabled={!value.extensionFilterEnabled}
                onChange={(event) => set("extensions", event.target.value.split(",").map((part) => part.trim().replace(/^\./, "")).filter(Boolean))}
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Key notation</legend>
            <div className="segmented" aria-label="Key notation">
              {([
                { value: "standard", label: "Standard" },
                { value: "custom", label: "Custom" },
                { value: "combined", label: "Combined" },
                { value: "djCombined", label: "DJ Notation + Key" },
              ] as const).map((notation) => (
                <button
                  type="button"
                  className={value.notation === notation.value ? "active" : ""}
                  aria-pressed={value.notation === notation.value}
                  onClick={() => set("notation", notation.value)}
                  key={notation.value}
                >
                  {notation.label}
                </button>
              ))}
            </div>
            {(value.notation === "custom" || value.notation === "combined") && (
              <div className="custom-code-grid">
                {KEY_NAMES.map((name, index) => (
                  <label key={name}>
                    <span>{name}</span>
                    <input
                      aria-label={`Custom code for ${name}`}
                      value={value.customCodes[index] ?? ""}
                      onChange={(event) => {
                        const codes = [...value.customCodes];
                        codes[index] = event.target.value;
                        set("customCodes", codes);
                      }}
                    />
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend>Output destinations</legend>
            <label className="stacked-field compact-field">
              Separator
              <input value={value.delimiter} onChange={(event) => set("delimiter", event.target.value)} />
            </label>
            <div className="output-grid">
              {Object.entries(value.outputs).map(([field, mode]) => (
                <label key={field}>
                  <span>{field === "initialKey" ? "Initial key" : field === "bpm" ? "Detected BPM" : field}</span>
                  <select
                    aria-label={`${field} output`}
                    value={mode}
                    onChange={(event) => setOutput(field as keyof Settings["outputs"], event.target.value as OutputMode)}
                  >
                    <option value="none">Do not write</option>
                    {field !== "bpm" && <option value="prepend">Prepend</option>}
                    {field !== "bpm" && <option value="append">Append</option>}
                    <option value="overwrite">{field === "bpm" ? "Overwrite BPM" : "Overwrite"}</option>
                  </select>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="toggle-row compact-toggle">
            <span><strong>Compact rows</strong><small>Fit more tracks in the batch table.</small></span>
            <input
              type="checkbox"
              checked={value.presentation.compactRows}
              onChange={(event) => set("presentation", { ...value.presentation, compactRows: event.target.checked })}
            />
          </label>
        </div>

        <footer className="settings-footer">
          <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button primary" type="button" onClick={onSave}>Save settings</button>
        </footer>
      </section>
    </div>
  );
}

type ColumnDefinition = {
  key: SortKey;
  label: string;
  defaultWidth: number;
  minWidth: number;
};

const COLUMNS: ColumnDefinition[] = [
  { key: "filename", label: "Filename", defaultWidth: 240, minWidth: 150 },
  { key: "title", label: "Title", defaultWidth: 165, minWidth: 90 },
  { key: "artist", label: "Artist", defaultWidth: 145, minWidth: 90 },
  { key: "album", label: "Album", defaultWidth: 145, minWidth: 90 },
  { key: "comment", label: "Comment", defaultWidth: 170, minWidth: 90 },
  { key: "grouping", label: "Grouping", defaultWidth: 140, minWidth: 90 },
  { key: "initialKey", label: "Initial key", defaultWidth: 100, minWidth: 78 },
  { key: "initialBpm", label: "BPM tag", defaultWidth: 100, minWidth: 78 },
  { key: "detectedBpm", label: "Detected BPM", defaultWidth: 115, minWidth: 90 },
  { key: "detectedCode", label: "Detected key", defaultWidth: 120, minWidth: 92 },
];

type ColumnLayout = {
  visible: SortKey[];
  order: SortKey[];
  widths: Record<SortKey, number>;
};

const COLUMN_LAYOUT_STORAGE_KEY = "neo-keyfinder.table-layout.v1";
const MAX_COLUMN_WIDTH = 600;
const COLUMN_KEYS = new Set<SortKey>(COLUMNS.map((column) => column.key));

function defaultColumnLayout(): ColumnLayout {
  return {
    visible: COLUMNS.map((column) => column.key),
    order: COLUMNS.map((column) => column.key),
    widths: Object.fromEntries(COLUMNS.map((column) => [column.key, column.defaultWidth])) as Record<SortKey, number>,
  };
}

function loadColumnLayout(): ColumnLayout {
  const fallback = defaultColumnLayout();
  if (typeof window === "undefined") return fallback;
  try {
    const stored = JSON.parse(window.localStorage.getItem(COLUMN_LAYOUT_STORAGE_KEY) ?? "null") as Partial<ColumnLayout> | null;
    if (!stored) return fallback;
    let visible = Array.isArray(stored.visible)
      ? [...new Set(stored.visible.filter((key): key is SortKey => COLUMN_KEYS.has(key as SortKey)))]
      : fallback.visible;
    const isLegacyLayout = Array.isArray(stored.order) && !stored.order.includes("initialBpm");
    const storedOrder = Array.isArray(stored.order)
      ? [...new Set(stored.order.filter((key): key is SortKey => COLUMN_KEYS.has(key as SortKey)))]
      : [];
    if (isLegacyLayout) {
      if (!visible.includes("initialBpm")) visible = [...visible, "initialBpm"];
      const detectedBpmIndex = storedOrder.indexOf("detectedBpm");
      storedOrder.splice(detectedBpmIndex >= 0 ? detectedBpmIndex : storedOrder.length, 0, "initialBpm");
    }
    const order = [
      ...storedOrder,
      ...fallback.order.filter((key) => !storedOrder.includes(key)),
    ];
    const widths = { ...fallback.widths };
    for (const column of COLUMNS) {
      const width = stored.widths?.[column.key];
      if (typeof width === "number" && Number.isFinite(width)) {
        widths[column.key] = Math.max(column.minWidth, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
      }
    }
    return { visible: visible.length ? visible : fallback.visible, order, widths };
  } catch {
    return fallback;
  }
}

function ColumnSelector({
  columns,
  visible,
  onToggle,
  onShowAll,
  onResetWidths,
  onResetOrder,
}: {
  columns: ColumnDefinition[];
  visible: SortKey[];
  onToggle: (key: SortKey) => void;
  onShowAll: () => void;
  onResetWidths: () => void;
  onResetOrder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="column-selector" ref={rootRef}>
      <button
        type="button"
        aria-label="Choose table columns"
        aria-haspopup="menu"
        aria-expanded={open}
        ref={toggleRef}
        onClick={() => setOpen((current) => !current)}
      >
        Columns
      </button>
      {open && (
        <div className="column-selector-popover" role="menu" aria-label="Table columns">
          <p>Visible columns</p>
          {columns.map((column) => {
            const checked = visible.includes(column.key);
            return (
              <label key={column.key}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={checked && visible.length === 1}
                  onChange={() => onToggle(column.key)}
                />
                <span>{column.label}</span>
              </label>
            );
          })}
          <div className="column-selector-actions">
            <button type="button" onClick={onShowAll}>Show all</button>
            <button type="button" onClick={onResetWidths}>Reset widths</button>
            <button type="button" onClick={onResetOrder}>Reset order</button>
          </div>
        </div>
      )}
    </div>
  );
}

function LibraryPanel({
  playlists,
  warnings,
  busy,
  onRefresh,
  onImport,
  onOpen,
  hidden,
}: {
  playlists: Playlist[];
  warnings: PlaylistWarning[];
  busy: boolean;
  onRefresh: () => void;
  onImport: () => void;
  onOpen: (playlist: Playlist) => void;
  hidden: boolean;
}) {
  const grouped = useMemo(() => {
    const result = new Map<Playlist["source"], Playlist[]>();
    for (const playlist of playlists) {
      result.set(playlist.source, [...(result.get(playlist.source) ?? []), playlist]);
    }
    return result;
  }, [playlists]);
  return (
    <aside id="library-sidebar" className="library-panel" aria-label={t("library.title")} hidden={hidden}>
      <header>
        <div>
          <p className="eyebrow">{t("library.readOnly")}</p>
          <h2>{t("library.title")}</h2>
        </div>
        <div className="library-header-actions">
          <button className="icon-button small" type="button" title={t("library.refresh")} aria-label={t("library.refresh")} disabled={busy} onClick={onRefresh}>↻</button>
        </div>
      </header>
      <button className="button secondary import-playlist" type="button" disabled={busy} onClick={onImport}>+ {t("library.import")}</button>
      <div className="library-list">
        {playlists.length === 0 && <p className="library-empty">{t("library.empty")}</p>}
        {[...grouped.entries()].map(([source, sourcePlaylists]) => (
          <section className="library-source" key={source}>
            <h3>{source}</h3>
            {sourcePlaylists.map((playlist) => (
              <button type="button" onClick={() => onOpen(playlist)} title={playlist.origin} key={playlist.id}>
                <span>{playlist.name}</span><small>{playlist.tracks.length}</small>
              </button>
            ))}
          </section>
        ))}
      </div>
      {warnings.length > 0 && <p className="library-warning" title={warnings.map((warning) => warning.message).join("\n")}>{warnings.length} library warning{warnings.length === 1 ? "" : "s"}</p>}
    </aside>
  );
}

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string; url: string }
  | { kind: "none" }
  | { kind: "failed" };

function versionParts(value: string): number[] {
  return value.replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate: string, current: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return false;
}

function AboutDialog({ info, update, onCheck, onOpen, onClose }: {
  info: AppInfo | null;
  update: UpdateState;
  onCheck: () => void;
  onOpen: (url: string) => void;
  onClose: () => void;
}) {
  const updateMessage = update.kind === "checking" ? t("updates.checking")
    : update.kind === "current" ? t("updates.current")
      : update.kind === "available" ? t("updates.available", { version: update.version })
        : update.kind === "none" ? t("updates.none")
          : update.kind === "failed" ? t("updates.failed") : "";
  return (
    <div className="modal-backdrop centered" role="presentation" onMouseDown={onClose}>
      <section className="about-panel" role="dialog" aria-modal="true" aria-labelledby="about-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="icon-button about-close" type="button" aria-label="Close about" onClick={onClose}>×</button>
        <span className="brand-mark about-mark" aria-hidden="true"><span /></span>
        <p className="eyebrow">GPL open source</p>
        <h2 id="about-title">{t("about.title")}</h2>
        <p>{t("about.description")}</p>
        <p className="about-version">Version {info?.version ?? "…"}</p>
        <p className="about-detail">{t("about.license")}</p>
        <p className="about-detail">{t("about.dependencies")}</p>
        {updateMessage && <p className={`update-message update-message--${update.kind}`}>{updateMessage}</p>}
        <div className="about-actions">
          <button className="button secondary" type="button" disabled={update.kind === "checking" || !info} onClick={onCheck}>{t("updates.check")}</button>
          {update.kind === "available" && <button className="button primary" type="button" onClick={() => onOpen(update.url)}>Open release</button>}
          {info && <button className="button ghost" type="button" onClick={() => onOpen(info.projectUrl)}>Project page</button>}
        </div>
      </section>
    </div>
  );
}

function ErrorDialog({ track, onClose }: { track: Track; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const report = JSON.stringify({
    file: track.filename,
    path: track.path,
    status: track.status,
    error: track.error,
  }, null, 2);
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="modal-backdrop centered" role="presentation" onMouseDown={onClose}>
      <section className="error-panel" role="dialog" aria-modal="true" aria-labelledby="error-title" aria-describedby="error-message" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">Track processing error</p>
            <h2 id="error-title">Couldn’t process {track.filename}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close error details" onClick={onClose}>×</button>
        </header>
        <p id="error-message" className="error-message">{track.error?.message ?? "The native engine did not provide an error message."}</p>
        <dl className="error-metadata">
          <div><dt>Code</dt><dd>{track.error?.code ?? "UNKNOWN_ERROR"}</dd></div>
          <div><dt>Stage</dt><dd>{track.error?.stage ?? "unknown"}</dd></div>
          <div><dt>Status</dt><dd>{track.status}</dd></div>
          <div className="error-path"><dt>File</dt><dd>{track.path}</dd></div>
        </dl>
        <details className="technical-details">
          <summary>Technical report</summary>
          <pre>{report}</pre>
          <small>This build records the complete structured engine error. Native stack traces are not currently available.</small>
        </details>
        <footer>
          <button className="button secondary" type="button" onClick={() => void copyReport()}>{copied ? "Copied" : "Copy report"}</button>
          <button className="button primary" type="button" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}

function WriteConfirmationDialog({
  count,
  writesBpm,
  writesComment,
  onConfirm,
  onClose,
}: {
  count: number;
  writesBpm: boolean;
  writesComment: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const noun = count === 1 ? "file" : "files";
  return (
    <div className="modal-backdrop centered" role="presentation" onMouseDown={onClose}>
      <section className="write-confirmation-panel" role="dialog" aria-modal="true" aria-labelledby="write-confirmation-title" onMouseDown={(event) => event.stopPropagation()}>
        <p className="eyebrow">Confirm metadata write</p>
        <h2 id="write-confirmation-title">Write metadata to {count} {noun}?</h2>
        <p>
          {writesBpm
            ? "Detected BPM will be rounded and written to the dedicated BPM tag."
            : "The configured detected-key destinations will be updated."}
          {!writesComment && " Comment tags will not be changed."}
        </p>
        <footer>
          <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="button primary" type="button" onClick={onConfirm}>Write {count} {noun}</button>
        </footer>
      </section>
    </div>
  );
}

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function createWaveformPath(peaks: number[]): string {
  if (peaks.length === 0) return "M0 12H100";
  const step = 100 / peaks.length;
  return peaks.map((peak, index) => {
    const x = (index + 0.5) * step;
    const amplitude = 0.7 + Math.max(0, Math.min(1, peak)) * 10.3;
    return `M${x.toFixed(3)} ${(12 - amplitude).toFixed(3)}V${(12 + amplitude).toFixed(3)}`;
  }).join(" ");
}

type MediaPosition = { x: number; y: number };

const MEDIA_POSITION_STORAGE_KEY = "neo-keyfinder.media-position.v1";

function loadMediaPosition(): MediaPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = JSON.parse(window.localStorage.getItem(MEDIA_POSITION_STORAGE_KEY) ?? "null") as Partial<MediaPosition> | null;
    return stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)
      ? { x: Number(stored.x), y: Number(stored.y) }
      : null;
  } catch {
    return null;
  }
}

function clampMediaPosition(position: MediaPosition, width: number, height: number): MediaPosition {
  return {
    x: Math.max(0, Math.min(position.x, Math.max(0, window.innerWidth - width))),
    y: Math.max(0, Math.min(position.y, Math.max(0, window.innerHeight - height))),
  };
}

function saveMediaPosition(position: MediaPosition | null) {
  try {
    if (position) window.localStorage.setItem(MEDIA_POSITION_STORAGE_KEY, JSON.stringify(position));
    else window.localStorage.removeItem(MEDIA_POSITION_STORAGE_KEY);
  } catch {
    // Playback remains movable when storage is unavailable.
  }
}

function MediaControls({
  track,
  paused,
  currentTime,
  duration,
  volume,
  muted,
  canPrevious,
  canNext,
  onTogglePlayback,
  onPrevious,
  onNext,
  onSeek,
  onVolume,
  onToggleMute,
  onClose,
}: {
  track: Track;
  paused: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  canPrevious: boolean;
  canNext: boolean;
  onTogglePlayback: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (volume: number) => void;
  onToggleMute: () => void;
  onClose: () => void;
}) {
  const trackLabel = `${track.title || track.filename}${track.artist ? ` - ${track.artist}` : ""}`;
  const slotRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [waveformLoading, setWaveformLoading] = useState(true);
  const [position, setPosition] = useState<MediaPosition | null>(loadMediaPosition);
  const [floatingWidth, setFloatingWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dockPreview, setDockPreview] = useState(false);
  const [justDocked, setJustDocked] = useState(false);
  const positionRef = useRef(position);
  const dockTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    pointerX: number;
    pointerY: number;
    originX: number;
    originY: number;
    width: number;
    height: number;
    wasFloating: boolean;
    active: boolean;
  } | null>(null);
  const waveformPath = useMemo(() => createWaveformPath(waveform), [waveform]);
  const playedFraction = duration > 0
    ? Math.max(0, Math.min(1, currentTime / duration))
    : 0;

  const updatePosition = (next: MediaPosition | null) => {
    positionRef.current = next;
    setPosition(next);
  };

  const dockBounds = () => {
    const slot = slotRef.current?.getBoundingClientRect();
    const toolbar = slotRef.current?.closest<HTMLElement>(".toolbar")?.getBoundingClientRect();
    return toolbar && toolbar.width > 0 && toolbar.height > 0 ? toolbar : slot;
  };

  const isOverDock = (x: number, y: number) => {
    const dock = dockBounds();
    return !!dock && x >= dock.left && x <= dock.right && y >= dock.top && y <= dock.bottom;
  };

  useEffect(() => {
    const clampToWindow = () => {
      const root = rootRef.current;
      const current = positionRef.current;
      if (!root || !current) return;
      const slotWidth = slotRef.current?.getBoundingClientRect().width ?? 0;
      const rect = root.getBoundingClientRect();
      const width = slotWidth || rect.width || root.offsetWidth;
      if (slotWidth) setFloatingWidth(slotWidth);
      const next = clampMediaPosition(current, width, rect.height || root.offsetHeight);
      updatePosition(next);
      saveMediaPosition(next);
    };
    clampToWindow();
    window.addEventListener("resize", clampToWindow);
    return () => window.removeEventListener("resize", clampToWindow);
  }, []);

  useEffect(() => () => {
    if (dockTimerRef.current !== null) window.clearTimeout(dockTimerRef.current);
  }, []);

  useEffect(() => {
    let disposed = false;
    setWaveform([]);
    setWaveformLoading(true);
    getAudioWaveform(track.path, 96)
      .then((peaks) => {
        if (!disposed) setWaveform(peaks);
      })
      .catch(() => {
        if (!disposed) setWaveform([]);
      })
      .finally(() => {
        if (!disposed) setWaveformLoading(false);
      });
    return () => { disposed = true; };
  }, [track.path]);

  const startDragging = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest("button, input, a, select, textarea")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const wasFloating = positionRef.current !== null;
    dragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      width: rect.width,
      height: rect.height,
      wasFloating,
      active: wasFloating,
    };
    if (wasFloating) setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - active.pointerX;
    const deltaY = event.clientY - active.pointerY;
    if (!active.active) {
      if (Math.hypot(deltaX, deltaY) < 4) return;
      active.active = true;
      setFloatingWidth(active.width);
      setDragging(true);
    }
    updatePosition(clampMediaPosition({
      x: active.originX + deltaX,
      y: active.originY + deltaY,
    }, active.width, active.height));
    setDockPreview(isOverDock(event.clientX, event.clientY));
    event.preventDefault();
  };

  const stopDragging = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const active = dragRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    setDockPreview(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!active.active) return;

    if (cancelled && !active.wasFloating) {
      updatePosition(null);
      setFloatingWidth(null);
      saveMediaPosition(null);
      return;
    }

    const overDock = !cancelled && isOverDock(event.clientX, event.clientY);
    if (overDock) {
      updatePosition(null);
      setFloatingWidth(null);
      saveMediaPosition(null);
      setJustDocked(true);
      if (dockTimerRef.current !== null) window.clearTimeout(dockTimerRef.current);
      dockTimerRef.current = window.setTimeout(() => {
        setJustDocked(false);
        dockTimerRef.current = null;
      }, 320);
    } else if (positionRef.current) {
      saveMediaPosition(positionRef.current);
    }
  };

  return (
    <div className={`media-player-slot ${dockPreview ? "is-snap-target" : ""} ${justDocked ? "has-snapped" : ""}`} ref={slotRef}>
      <section
        ref={rootRef}
        className={`media-controls ${position ? "is-floating" : ""} ${dragging ? "is-dragging" : ""} ${dockPreview ? "is-over-dock" : ""}`}
        aria-label="Media controls"
        style={position ? { left: position.x, top: position.y, width: floatingWidth ?? undefined } : undefined}
        onPointerDown={startDragging}
        onPointerMove={drag}
        onPointerUp={(event) => stopDragging(event)}
        onPointerCancel={(event) => stopDragging(event, true)}
      >
        <div className="media-control-row">
          <button type="button" aria-label="Previous track" disabled={!canPrevious} onClick={onPrevious}>⏮</button>
          <button className="media-play-button" type="button" aria-label={paused ? "Play" : "Pause"} onClick={onTogglePlayback}>
            {paused ? "▶" : "Ⅱ"}
          </button>
          <button type="button" aria-label="Next track" disabled={!canNext} onClick={onNext}>⏭</button>
          <div className="media-volume-control">
            <div className="media-volume-popover">
              <input
                type="range"
                aria-label="Playback volume"
                aria-orientation="vertical"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(event) => onVolume(Number(event.target.value))}
              />
            </div>
            <button type="button" aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} onClick={onToggleMute}>
              <VolumeIcon muted={muted || volume === 0} />
            </button>
          </div>
        </div>
        <div className="media-track-progress">
          <span className="media-track-name" title={`${trackLabel}\n${track.path}`}>{trackLabel}</span>
          <div className="media-seek-row">
            <div className="media-time" aria-label={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}`}>
              <span>{formatPlaybackTime(currentTime)}</span>
              <span>{formatPlaybackTime(duration)}</span>
            </div>
            <div className={`media-waveform ${waveformLoading ? "is-loading" : ""}`} aria-busy={waveformLoading}>
              <svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <clipPath id="media-waveform-played">
                    <rect width={playedFraction * 100} height="24" />
                  </clipPath>
                </defs>
                <path className="media-waveform-base" d={waveformPath} />
                <path className="media-waveform-progress" d={waveformPath} clipPath="url(#media-waveform-played)" />
                {duration > 0 && (
                  <line className="media-waveform-playhead" x1={playedFraction * 100} x2={playedFraction * 100} y1="1" y2="23" />
                )}
              </svg>
              <input
                type="range"
                aria-label="Seek"
                aria-valuetext={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}`}
                min="0"
                max={Math.max(duration, 0.01)}
                step="0.1"
                value={Math.min(currentTime, Math.max(duration, 0.01))}
                disabled={duration <= 0}
                onChange={(event) => onSeek(Number(event.target.value))}
              />
            </div>
          </div>
        </div>
        <div className="media-utility-controls">
          <button
            className="media-close-button"
            type="button"
            aria-label="Close media player"
            title="Close media player"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
      </section>
    </div>
  );
}

function TrackTable({
  tracks,
  selected,
  onSelected,
  onOpenError,
  onPlayTrack,
  onRevealTrack,
  onRemoveSelected,
  onClearDetectedKeys,
  queued,
  sort,
  onSort,
  visibleColumns,
  columnWidths,
  onColumnWidthChange,
  onColumnReorder,
  playingTrackId,
  playbackPaused,
  compact,
  actionsDisabled,
}: {
  tracks: Track[];
  selected: Set<string>;
  onSelected: (next: Set<string>) => void;
  onOpenError: (track: Track) => void;
  onPlayTrack: (track: Track) => void;
  onRevealTrack: (track: Track) => void;
  onRemoveSelected: () => void;
  onClearDetectedKeys: () => void;
  queued: Set<string>;
  sort: SortState;
  onSort: (sort: SortState) => void;
  visibleColumns: ColumnDefinition[];
  columnWidths: Record<SortKey, number>;
  onColumnWidthChange: (key: SortKey, width: number) => void;
  onColumnReorder: (source: SortKey, target: SortKey, position: "before" | "after") => void;
  playingTrackId: string | null;
  playbackPaused: boolean;
  compact: boolean;
  actionsDisabled: boolean;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(470);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; trackId: string } | null>(null);
  const [draggedColumn, setDraggedColumn] = useState<SortKey | null>(null);
  const [columnDropTarget, setColumnDropTarget] = useState<{
    key: SortKey;
    position: "before" | "after";
  } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowHeight = compact ? 36 : 48;
  const sorted = useMemo(() => orderTracks(tracks, sort), [tracks, sort]);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const end = Math.min(sorted.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 5);
  const visible = sorted.slice(start, end);
  const allSelected = tracks.length > 0 && tracks.every((track) => selected.has(track.id));
  const contextTrack = contextMenu
    ? tracks.find((track) => track.id === contextMenu.trackId) ?? null
    : null;
  const gridColumns = `42px ${visibleColumns.map((column) => `${columnWidths[column.key]}px`).join(" ")}`;
  const tableWidth = 42 + visibleColumns.reduce((total, column) => total + columnWidths[column.key], 0);

  const toggleSort = (key: SortKey) => {
    if (!sort || sort.key !== key) onSort({ key, direction: 1 });
    else if (sort.direction === 1) onSort({ key, direction: -1 });
    else onSort(null);
  };

  const beginColumnResize = (column: ColumnDefinition, event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidths[column.key];
    const resize = (moveEvent: PointerEvent) => {
      const width = Math.max(
        column.minWidth,
        Math.min(MAX_COLUMN_WIDTH, startWidth + moveEvent.clientX - startX),
      );
      onColumnWidthChange(column.key, Math.round(width));
    };
    const finish = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-column");
    };
    document.body.classList.add("is-resizing-column");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const resizeColumnWithKeyboard = (column: ColumnDefinition, event: React.KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 25 : 10;
    const direction = event.key === "ArrowRight" ? 1 : -1;
    onColumnWidthChange(
      column.key,
      Math.max(column.minWidth, Math.min(MAX_COLUMN_WIDTH, columnWidths[column.key] + direction * step)),
    );
  };

  const beginColumnReorder = (column: ColumnDefinition, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    let moved = false;
    let dropTarget: { key: SortKey; position: "before" | "after" } | null = null;

    document.body.classList.add("is-reordering-column");
    setDraggedColumn(column.key);

    const move = (moveEvent: PointerEvent) => {
      if (!moved && Math.abs(moveEvent.clientX - startX) < 4) return;
      moved = true;
      const headers = [...(tableRef.current?.querySelectorAll<HTMLElement>("[data-column-key]") ?? [])];
      const target = headers.find((header) => {
        const bounds = header.getBoundingClientRect();
        return moveEvent.clientX >= bounds.left && moveEvent.clientX <= bounds.right;
      });
      const key = target?.dataset.columnKey as SortKey | undefined;
      if (!target || !key || key === column.key) {
        dropTarget = null;
        setColumnDropTarget(null);
        return;
      }
      const bounds = target.getBoundingClientRect();
      dropTarget = {
        key,
        position: moveEvent.clientX < bounds.left + bounds.width / 2 ? "before" : "after",
      };
      setColumnDropTarget(dropTarget);
    };

    const finish = (apply: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finishWithReorder);
      window.removeEventListener("pointercancel", cancel);
      if (apply && moved && dropTarget) {
        onColumnReorder(column.key, dropTarget.key, dropTarget.position);
      }
      setDraggedColumn(null);
      setColumnDropTarget(null);
      window.setTimeout(() => document.body.classList.remove("is-reordering-column"), 0);
    };
    const finishWithReorder = () => finish(true);
    const cancel = () => finish(false);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finishWithReorder, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };

  const activateRow = (index: number) => {
    const track = sorted[index];
    if (!track) return;
    setActiveId(track.id);
    setSelectionAnchorId(track.id);
    onSelected(new Set([track.id]));

    const viewport = viewportRef.current;
    if (!viewport) return;
    const rowTop = index * rowHeight;
    const rowBottom = rowTop + rowHeight;
    let nextScroll = viewport.scrollTop;
    if (rowTop < viewport.scrollTop) nextScroll = rowTop;
    else if (rowBottom > viewport.scrollTop + viewportHeight) {
      nextScroll = rowBottom - viewportHeight;
    }
    if (nextScroll !== viewport.scrollTop) {
      viewport.scrollTop = nextScroll;
      setScrollTop(nextScroll);
    }
  };

  const selectRow = (
    track: Track,
    modifiers: Pick<React.MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">,
    toggleWithoutModifier = false,
  ) => {
    setActiveId(track.id);
    if (modifiers.shiftKey) {
      const targetIndex = sorted.findIndex((candidate) => candidate.id === track.id);
      let anchorIndex = selectionAnchorId
        ? sorted.findIndex((candidate) => candidate.id === selectionAnchorId)
        : -1;
      if (anchorIndex < 0) {
        anchorIndex = sorted.findIndex((candidate) => selected.has(candidate.id));
      }
      if (anchorIndex < 0) anchorIndex = targetIndex;
      const next = modifiers.metaKey || modifiers.ctrlKey ? new Set(selected) : new Set<string>();
      const first = Math.min(anchorIndex, targetIndex);
      const last = Math.max(anchorIndex, targetIndex);
      for (let index = first; index <= last; index += 1) next.add(sorted[index].id);
      setSelectionAnchorId(sorted[anchorIndex].id);
      onSelected(next);
      return;
    }
    if (modifiers.metaKey || modifiers.ctrlKey || toggleWithoutModifier) {
      const next = new Set(selected);
      if (next.has(track.id)) next.delete(track.id); else next.add(track.id);
      setSelectionAnchorId(track.id);
      onSelected(next);
      return;
    }
    if (selected.has(track.id)) {
      const next = new Set(selected);
      next.delete(track.id);
      setSelectionAnchorId(track.id);
      onSelected(next);
      return;
    }
    setSelectionAnchorId(track.id);
    onSelected(new Set([track.id]));
  };

  const scrollHorizontally = (delta: number) => {
    const table = tableRef.current;
    if (!table || delta === 0) return false;
    const previous = table.scrollLeft;
    const maximum = Math.max(0, table.scrollWidth - table.clientWidth);
    table.scrollLeft = Math.max(0, Math.min(maximum, previous + delta));
    return table.scrollLeft !== previous;
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const delta = Math.abs(event.deltaX) > 0.5
      ? event.deltaX
      : event.shiftKey ? event.deltaY : 0;
    if (scrollHorizontally(delta)) event.preventDefault();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      scrollHorizontally(event.key === "ArrowLeft" ? -100 : 100);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if ((event.target as HTMLElement).closest("button, select, textarea")) return;
    event.preventDefault();
    const current = activeId
      ? sorted.findIndex((track) => track.id === activeId)
      : sorted.findIndex((track) => selected.has(track.id));
    const next = event.key === "ArrowDown"
      ? Math.min(sorted.length - 1, current < 0 ? 0 : current + 1)
      : Math.max(0, current < 0 ? sorted.length - 1 : current - 1);
    activateRow(next);
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateHeight = () => {
      if (viewport.clientHeight > 0) setViewportHeight(viewport.clientHeight);
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    document.body.classList.remove("is-reordering-column");
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        tableRef.current?.focus();
      }
    };
    const closeOnBlur = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", closeOnBlur);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", closeOnBlur);
    };
  }, [contextMenu]);

  return (
    <div
      className={`track-table ${compact ? "track-table--compact" : ""}`}
      role="grid"
      aria-label="Audio tracks"
      aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Control+A Meta+A"
      aria-activedescendant={activeId ? `track-row-${activeId}` : undefined}
      tabIndex={0}
      ref={tableRef}
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
      style={{
        "--columns": gridColumns,
        "--table-width": `${tableWidth}px`,
      } as React.CSSProperties}
    >
      <div className="track-header" role="row">
        <div className="select-cell" role="columnheader">
          <input
            type="checkbox"
            aria-label="Select all tracks"
            checked={allSelected}
            onChange={(event) => onSelected(event.target.checked ? new Set(tracks.map((track) => track.id)) : new Set())}
          />
        </div>
        {visibleColumns.map((column) => (
          <div
            className={`column-header ${draggedColumn === column.key ? "is-dragging" : ""} ${
              columnDropTarget?.key === column.key ? `is-drop-${columnDropTarget.position}` : ""
            }`}
            data-column-key={column.key}
            role="columnheader"
            tabIndex={0}
            aria-sort={sort?.key === column.key ? (sort.direction === 1 ? "ascending" : "descending") : "none"}
            onClick={() => toggleSort(column.key)}
            onKeyDown={(event) => {
              if ((event.target as HTMLElement).closest(".column-resize-handle")) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              toggleSort(column.key);
            }}
            key={column.key}
          >
            <span className="column-header-label">
              {column.label}<span aria-hidden="true">{sort?.key === column.key ? (sort.direction === 1 ? " ↑" : " ↓") : ""}</span>
            </span>
            <span
              className="column-drag-handle"
              role="button"
              aria-label={`Reorder ${column.label} column`}
              title={`Drag to reorder ${column.label}`}
              tabIndex={0}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => beginColumnReorder(column, event)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                event.stopPropagation();
                const index = visibleColumns.findIndex((candidate) => candidate.key === column.key);
                const targetIndex = event.key === "ArrowLeft" ? index - 1 : index + 1;
                const target = visibleColumns[targetIndex];
                if (target) {
                  onColumnReorder(
                    column.key,
                    target.key,
                    event.key === "ArrowLeft" ? "before" : "after",
                  );
                }
              }}
            >
              <span aria-hidden="true">⠿</span>
            </span>
            <span
              className="column-resize-handle"
              role="separator"
              aria-label={`Resize ${column.label} column`}
              aria-orientation="vertical"
              aria-valuemin={column.minWidth}
              aria-valuemax={MAX_COLUMN_WIDTH}
              aria-valuenow={columnWidths[column.key]}
              tabIndex={0}
              onPointerDown={(event) => beginColumnResize(column, event)}
              onKeyDown={(event) => resizeColumnWithKeyboard(column, event)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onColumnWidthChange(column.key, column.defaultWidth);
              }}
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        ))}
      </div>
      <div
        className="track-viewport"
        style={{ height: viewportHeight }}
        ref={viewportRef}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          setContextMenu(null);
        }}
      >
        {sorted.length === 0 && (
          <div className="table-no-results" role="status">No tracks match this filter</div>
        )}
        <div style={{ height: start * rowHeight }} aria-hidden="true" />
        {visible.map((track) => {
          const visualStatus = track.error ? "failed" : track.status;
          const isQueued = queued.has(track.id);
          return (
          <div
            id={`track-row-${track.id}`}
            className={`track-row track-row--${visualStatus} ${selected.has(track.id) ? "is-selected" : ""} ${activeId === track.id ? "is-active" : ""} ${isQueued ? "is-queued" : ""} ${playingTrackId === track.id ? `is-playing ${playbackPaused ? "is-playback-paused" : ""}` : ""}`}
            role="row"
            aria-busy={isQueued}
            style={{ height: rowHeight }}
            title={track.error?.message ?? track.path}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button, input")) return;
              selectRow(track, event);
              tableRef.current?.focus();
            }}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest("button, input")) return;
              onPlayTrack(track);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setActiveId(track.id);
              if (!selected.has(track.id)) {
                setSelectionAnchorId(track.id);
                onSelected(new Set([track.id]));
              }
              setContextMenu({
                x: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)),
                y: Math.max(8, Math.min(event.clientY, window.innerHeight - 145)),
                trackId: track.id,
              });
            }}
            key={track.id}
          >
            <div className="select-cell" role="gridcell">
              <input
                type="checkbox"
                aria-label={`Select ${track.filename}`}
                checked={selected.has(track.id)}
                readOnly
                onClick={(event) => {
                  event.stopPropagation();
                  selectRow(track, event, true);
                }}
              />
            </div>
            {visibleColumns.map((column) => (
              <div className={column.key === "detectedCode" ? "key-cell" : ""} role="gridcell" key={column.key}>
                {column.key === "filename" && <span className={`row-status row-status--${visualStatus}`} aria-label={isQueued ? "queued" : visualStatus} />}
                {column.key === "detectedCode" && track.error ? (
                  <button className="error-details-button" type="button" aria-label={`View error for ${track.filename}`} onClick={() => onOpenError(track)}>View error</button>
                ) : column.key === "initialBpm" || column.key === "detectedBpm" ? (
                  <span>{formatBpm(track[column.key])}</span>
                ) : (
                  <span>{track[column.key] || "—"}</span>
                )}
              </div>
            ))}
          </div>
          );
        })}
        <div style={{ height: Math.max(0, (sorted.length - end) * rowHeight) }} aria-hidden="true" />
      </div>
      {contextMenu && (
        <div
          className="row-context-menu"
          role="menu"
          aria-label="Selected row actions"
          ref={menuRef}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextTrack && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onPlayTrack(contextTrack);
                  setContextMenu(null);
                }}
              >
                {playingTrackId === contextTrack.id && !playbackPaused ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onRevealTrack(contextTrack);
                  setContextMenu(null);
                }}
              >
                {revealTrackLabel()}
              </button>
            </>
          )}
          <span role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={actionsDisabled}
            onClick={() => {
              onRemoveSelected();
              setContextMenu(null);
            }}
          >
            Remove selected rows
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={actionsDisabled}
            onClick={() => {
              onClearDetectedKeys();
              setContextMenu(null);
            }}
          >
            Clear detected keys
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [engine, setEngine] = useState<EngineState>({ kind: "checking" });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [columnLayout, setColumnLayout] = useState<ColumnLayout>(loadColumnLayout);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ completed: 0, total: 0, fraction: 0 });
  const [busy, setBusy] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [libraryWarnings, setLibraryWarnings] = useState<PlaylistWarning[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [errorTrack, setErrorTrack] = useState<Track | null>(null);
  const [pendingWrite, setPendingWrite] = useState<Track[] | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [playbackPaused, setPlaybackPaused] = useState(true);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [playbackVolume, setPlaybackVolume] = useState(0.8);
  const [playbackMuted, setPlaybackMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackRequestRef = useRef(0);
  const tracksRef = useRef(tracks);
  const selectedRef = useRef(selected);
  const tableFilterRef = useRef(tableFilter);
  const lastSequence = useRef(new Map<string, number>());
  const finishedJobs = useRef(new Set<string>());
  const orderedColumns = useMemo(
    () => columnLayout.order
      .map((key) => COLUMNS.find((column) => column.key === key))
      .filter((column): column is ColumnDefinition => !!column),
    [columnLayout.order],
  );
  const visibleColumns = useMemo(
    () => orderedColumns.filter((column) => columnLayout.visible.includes(column.key)),
    [columnLayout.visible, orderedColumns],
  );
  const filteredTracks = useMemo(
    () => tracks.filter((track) => trackMatchesFilter(track, tableFilter)),
    [tableFilter, tracks],
  );

  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { tableFilterRef.current = tableFilter; }, [tableFilter]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLUMN_LAYOUT_STORAGE_KEY, JSON.stringify(columnLayout));
    } catch {
      // The table remains usable when storage is unavailable.
    }
  }, [columnLayout]);

  const toggleColumnVisibility = (key: SortKey) => {
    const isVisible = columnLayout.visible.includes(key);
    if (isVisible && columnLayout.visible.length === 1) return;
    setColumnLayout((current) => ({
      ...current,
      visible: isVisible
        ? current.visible.filter((candidate) => candidate !== key)
        : COLUMNS.filter((column) => current.visible.includes(column.key) || column.key === key)
          .map((column) => column.key),
    }));
    if (isVisible && sort?.key === key) setSort(null);
  };

  const setColumnWidth = (key: SortKey, width: number) => {
    const column = COLUMNS.find((candidate) => candidate.key === key);
    if (!column) return;
    setColumnLayout((current) => ({
      ...current,
      widths: {
        ...current.widths,
        [key]: Math.max(column.minWidth, Math.min(MAX_COLUMN_WIDTH, Math.round(width))),
      },
    }));
  };

  const reorderColumn = (source: SortKey, target: SortKey, position: "before" | "after") => {
    if (source === target) return;
    setColumnLayout((current) => {
      const order = current.order.filter((key) => key !== source);
      const targetIndex = order.indexOf(target);
      if (targetIndex < 0) return current;
      order.splice(targetIndex + (position === "after" ? 1 : 0), 0, source);
      return { ...current, order };
    });
  };

  const stopPlayback = useCallback(() => {
    playbackRequestRef.current += 1;
    const audio = audioRef.current;
    audioRef.current = null;
    audio?.pause();
    setPlayingTrackId(null);
    setPlaybackPaused(true);
    setPlaybackTime(0);
    setPlaybackDuration(0);
  }, []);

  const togglePlaybackPause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playbackPaused) {
      try {
        await audio.play();
        if (audioRef.current === audio) setPlaybackPaused(false);
      } catch (error) {
        setNotice(`Playback: ${errorMessage(error)}`);
      }
    } else {
      audio.pause();
      setPlaybackPaused(true);
    }
  }, [playbackPaused]);

  const toggleTrackPlayback = useCallback(async (track: Track) => {
    if (playingTrackId === track.id) {
      await togglePlaybackPause();
      return;
    }
    stopPlayback();
    const request = playbackRequestRef.current;
    try {
      const source = await prepareAudioPlayback(track.path);
      if (request !== playbackRequestRef.current) return;
      const audio = new Audio(source);
      audio.preload = "auto";
      audio.volume = playbackVolume;
      audio.muted = playbackMuted;
      const finish = () => {
        if (audioRef.current !== audio) return;
        audioRef.current = null;
        setPlayingTrackId(null);
        setPlaybackPaused(true);
        setPlaybackTime(0);
        setPlaybackDuration(0);
      };
      const updateTime = () => {
        if (audioRef.current === audio) setPlaybackTime(audio.currentTime);
      };
      const updateDuration = () => {
        if (audioRef.current === audio && Number.isFinite(audio.duration)) {
          setPlaybackDuration(audio.duration);
        }
      };
      audio.addEventListener("timeupdate", updateTime);
      audio.addEventListener("durationchange", updateDuration);
      audio.addEventListener("loadedmetadata", updateDuration, { once: true });
      audio.addEventListener("play", () => {
        if (audioRef.current === audio) setPlaybackPaused(false);
      });
      audio.addEventListener("pause", () => {
        if (audioRef.current === audio) setPlaybackPaused(true);
      });
      audio.addEventListener("ended", finish, { once: true });
      audio.addEventListener("error", () => {
        finish();
        setNotice(`Could not play ${track.filename}`);
      }, { once: true });
      audioRef.current = audio;
      setPlayingTrackId(track.id);
      setPlaybackPaused(false);
      setPlaybackTime(0);
      setPlaybackDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      await audio.play();
    } catch (error) {
      if (request !== playbackRequestRef.current) return;
      stopPlayback();
      setNotice(`Playback: ${errorMessage(error)}`);
    }
  }, [playbackMuted, playbackVolume, playingTrackId, stopPlayback, togglePlaybackPause]);

  const seekPlayback = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(seconds, Number.isFinite(audio.duration) ? audio.duration : seconds));
    setPlaybackTime(audio.currentTime);
  };

  const changePlaybackVolume = (volume: number) => {
    const next = Math.max(0, Math.min(1, volume));
    setPlaybackVolume(next);
    if (audioRef.current) audioRef.current.volume = next;
  };

  const togglePlaybackMute = () => {
    setPlaybackMuted((current) => {
      const next = !current;
      if (audioRef.current) audioRef.current.muted = next;
      return next;
    });
  };

  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  useEffect(() => {
    if (playingTrackId && !tracks.some((track) => track.id === playingTrackId)) stopPlayback();
  }, [playingTrackId, stopPlayback, tracks]);

  const playbackOrder = useMemo(() => orderTracks(tracks, sort), [sort, tracks]);
  const playbackIndex = playingTrackId
    ? playbackOrder.findIndex((track) => track.id === playingTrackId)
    : -1;
  const playingTrack = playbackIndex >= 0 ? playbackOrder[playbackIndex] : null;
  const playAdjacentTrack = (offset: -1 | 1) => {
    const target = playbackOrder[playbackIndex + offset];
    if (target) void toggleTrackPlayback(target);
  };

  useEffect(() => {
    const toggleWithSpace = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented || event.repeat || event.code !== "Space" ||
        event.metaKey || event.ctrlKey || event.altKey || !playingTrackId ||
        settingsDraft || aboutOpen || errorTrack
      ) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("button, input, select, textarea, [contenteditable='true'], [role='columnheader'], [role='separator']")
      ) return;
      event.preventDefault();
      void togglePlaybackPause();
    };
    window.addEventListener("keydown", toggleWithSpace);
    return () => window.removeEventListener("keydown", toggleWithSpace);
  }, [aboutOpen, errorTrack, playingTrackId, settingsDraft, togglePlaybackPause]);

  const openSettings = useCallback(() => {
    setAboutOpen(false);
    setErrorTrack(null);
    setSettingsDraft((current) => current ?? structuredClone(settings));
  }, [settings]);

  const checkEngine = useCallback(async () => {
    setEngine({ kind: "checking" });
    try {
      const health = await getNativeHealth();
      setEngine({ kind: "available", health });
    } catch (error) {
      setEngine({ kind: "unavailable", message: errorMessage(error) });
    }
  }, []);

  const addPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    setBusy(true);
    setNotice(`Reading ${paths.length} ${paths.length === 1 ? "path" : "paths"}…`);
    try {
      const result = await expandFiles(paths, settings);
      const nextTracks = mergeTracks(tracksRef.current, result.tracks);
      if (nextTracks.length !== tracksRef.current.length) {
        tracksRef.current = nextTracks;
        setTracks(nextTracks);
      }
      const warningSuffix = result.warnings.length ? ` · ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : "";
      setNotice(`Added ${result.tracks.length} track${result.tracks.length === 1 ? "" : "s"}${warningSuffix}`);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [settings]);

  const refreshLibraries = useCallback(async (nextSettings: Settings = settings) => {
    if (!nextSettings.features.playlistsEnabled) {
      setPlaylists([]);
      setLibraryWarnings([]);
      return;
    }
    setBusy(true);
    try {
      const result = await discoverLibraries(nextSettings);
      setPlaylists(result.playlists);
      setLibraryWarnings(result.warnings);
      if (result.warnings.length) {
        setNotice(`Loaded ${result.playlists.length} playlist${result.playlists.length === 1 ? "" : "s"} · ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
      }
    } catch (error) {
      setNotice(`Libraries: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }, [settings]);

  useEffect(() => {
    void checkEngine();
    loadSettings().then((saved) => {
      setSettings(saved);
      setLibraryOpen(saved.presentation.libraryOpen ?? true);
      void refreshLibraries(saved);
    }).catch((error) => setNotice(`Settings: ${errorMessage(error)}`));
  }, [checkEngine]);

  useEffect(() => {
    if (!settingsDraft) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsDraft(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsDraft]);

  useEffect(() => {
    const openSettingsShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== ",") return;
      event.preventDefault();
      openSettings();
    };
    window.addEventListener("keydown", openSettingsShortcut);
    return () => window.removeEventListener("keydown", openSettingsShortcut);
  }, [openSettings]);

  useEffect(() => {
    if (!errorTrack) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setErrorTrack(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [errorTrack]);

  useEffect(() => {
    const selectAllTracks = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "a" || tracks.length === 0) return;
      const target = event.target as HTMLElement | null;
      if (
        settingsDraft || aboutOpen || errorTrack ||
        target?.isContentEditable ||
        target?.closest("input, textarea, select")
      ) return;
      event.preventDefault();
      setSelected(new Set(tracks.map((track) => track.id)));
    };
    window.addEventListener("keydown", selectAllTracks);
    return () => window.removeEventListener("keydown", selectAllTracks);
  }, [tracks, settingsDraft, aboutOpen, errorTrack]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const isReorderingColumn = () => document.body.classList.contains("is-reordering-column");
    listenForFileDrops(
      (paths) => {
        if (!isReorderingColumn()) void addPaths(paths);
      },
      (hovering) => setDropHover(isReorderingColumn() ? false : hovering),
    )
      .then((unlisten) => { if (disposed) unlisten(); else cleanup = unlisten; })
      .catch(() => undefined);
    return () => { disposed = true; cleanup?.(); };
  }, [addPaths]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const handleEvent = (event: NativeEvent) => {
      const previous = lastSequence.current.get(event.jobId) ?? 0;
      if (event.sequence <= previous) return;
      lastSequence.current.set(event.jobId, event.sequence);
      if (event.event === "trackUpdated") {
        const updated = event.payload.track as Track;
        setQueued((current) => {
          if (!current.has(updated.id)) return current;
          const next = new Set(current);
          next.delete(updated.id);
          return next;
        });
        setTracks((current) => current.map((track) => track.id === updated.id ? updated : track));
      }
      if (event.event === "jobProgress") {
        setProgress({
          completed: event.payload.completed as number,
          total: event.payload.total as number,
          fraction: event.payload.fraction as number,
        });
      }
      if (event.event === "jobFinished") {
        setQueued(new Set());
        finishedJobs.current.add(event.jobId);
        setJobId((current) => current === event.jobId ? null : current);
        const wasCancelled = event.payload.cancelled as boolean;
        setNotice(wasCancelled ? "Analysis cancelled" : "Analysis complete");
      }
    };
    listenNativeEvents(handleEvent)
      .then((unlisten) => { if (disposed) unlisten(); else cleanup = unlisten; })
      .catch((error) => setNotice(`Events: ${errorMessage(error)}`));
    return () => { disposed = true; cleanup?.(); };
  }, []);

  const chooseFiles = async () => {
    try { await addPaths(await pickAudioFiles()); } catch (error) { setNotice(errorMessage(error)); }
  };
  const chooseFolders = async () => {
    try {
      const folders = await pickAudioFolders();
      if (folders.length) await addPaths(folders);
    } catch (error) { setNotice(errorMessage(error)); }
  };
  const openPlaylist = async (playlist: Playlist) => {
    if (tracks.length > 0 && !window.confirm(t("library.replaceWarning"))) return;
    setBusy(true);
    setNotice(`Loading ${playlist.name}…`);
    try {
      const result = await expandFiles(playlist.tracks, settings);
      tracksRef.current = result.tracks;
      selectedRef.current = new Set();
      setTracks(result.tracks);
      setSelected(new Set());
      setProgress({ completed: 0, total: 0, fraction: 0 });
      const warningCount = result.warnings.length;
      setNotice(`Loaded ${result.tracks.length} track${result.tracks.length === 1 ? "" : "s"} from ${playlist.name}${warningCount ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}`);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const importPlaylist = async () => {
    try {
      const path = await pickPlaylistFile();
      if (!path) return;
      const result = await loadPlaylist(path);
      setLibraryWarnings((current) => [...current, ...result.warnings]);
      if (!result.playlists.length) {
        setNotice(result.warnings[0]?.message ?? "The playlist contains no tracks.");
        return;
      }
      setPlaylists((current) => {
        const imported = result.playlists[0];
        return [...current.filter((playlist) => playlist.id !== imported.id), imported];
      });
      await openPlaylist(result.playlists[0]);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };
  const showAbout = async (checkUpdates = false) => {
    setAboutOpen(true);
    try {
      const info = appInfo ?? await getAppInfo();
      setAppInfo(info);
      if (checkUpdates) await checkForUpdates(info);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };
  const checkForUpdates = async (knownInfo: AppInfo | null = appInfo) => {
    setUpdate({ kind: "checking" });
    try {
      const info = knownInfo ?? await getAppInfo();
      setAppInfo(info);
      const response = await fetch(info.releaseMetadataUrl, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (response.status === 404) {
        setUpdate({ kind: "none" });
        return;
      }
      if (!response.ok) throw new Error(`Release service returned ${response.status}`);
      const release = await response.json() as { tag_name?: string; html_url?: string };
      if (!release.tag_name || !release.html_url) throw new Error("Published release metadata is incomplete");
      setUpdate(isNewerVersion(release.tag_name, info.version)
        ? { kind: "available", version: release.tag_name, url: release.html_url }
        : { kind: "current" });
    } catch {
      setUpdate({ kind: "failed" });
    }
  };
  const analyze = async () => {
    const candidates = orderTracks(tracks, sort).filter((track) => selected.size > 0
      ? selected.has(track.id) && track.status !== "analyzing"
      : !["analyzing", "completed"].includes(track.status));
    if (!candidates.length) return;
    const writeAuthorization = settings.automaticWrites
      ? window.confirm("Automatic writing is enabled. This analysis will modify the configured metadata fields in your audio files. Continue?")
      : false;
    if (settings.automaticWrites && !writeAuthorization) return;
    setQueued(new Set(candidates.map((track) => track.id)));
    try {
      setProgress({ completed: 0, total: candidates.length, fraction: 0 });
      const result = await startAnalysis(candidates, settings, writeAuthorization);
      if (!finishedJobs.current.has(result.jobId)) setJobId(result.jobId);
      setNotice(`Analyzing ${candidates.length} track${candidates.length === 1 ? "" : "s"}`);
    } catch (error) { setQueued(new Set()); setNotice(errorMessage(error)); }
  };
  const cancel = async () => {
    if (!jobId) return;
    try { await cancelAnalysis(jobId); setNotice("Cancelling after the current decode step…"); } catch (error) { setNotice(errorMessage(error)); }
  };
  const requestWrite = () => {
    const candidates = tracks.filter((track) => (selected.size === 0 || selected.has(track.id))
      && hasWritableResult(track, settings));
    if (!candidates.length) return;
    setPendingWrite(candidates);
  };
  const confirmWrite = async () => {
    const candidates = pendingWrite;
    if (!candidates?.length) return;
    setPendingWrite(null);
    setBusy(true);
    try {
      const result = await writeTracks(candidates, settings);
      const updates = new Map(result.tracks.map((track) => [track.id, track]));
      setTracks((current) => current.map((track) => updates.get(track.id) ?? track));
      const failures = result.tracks.filter((track) => track.error?.stage === "write");
      if (failures.length > 0) {
        setErrorTrack(failures[0]);
        setNotice(`Could not write ${failures.length} of ${result.tracks.length} track${result.tracks.length === 1 ? "" : "s"}`);
      } else {
        setNotice(`Wrote ${result.tracks.length} track${result.tracks.length === 1 ? "" : "s"}`);
      }
    } catch (error) { setNotice(errorMessage(error)); } finally { setBusy(false); }
  };
  const clearResults = () => {
    if (selectedRef.current.size === 0) return;
    const nextTracks = tracksRef.current.map((track) => selectedRef.current.has(track.id) ? {
      ...track, detectedKey: null, detectedCode: "", detectedBpm: null, status: "ready" as const, error: null,
    } : track);
    tracksRef.current = nextTracks;
    setTracks(nextTracks);
  };
  const removeSelected = () => {
    if (selectedRef.current.size === 0) return;
    const nextTracks = tracksRef.current.filter((track) => !selectedRef.current.has(track.id));
    tracksRef.current = nextTracks;
    selectedRef.current = new Set();
    setTracks(nextTracks);
    setSelected(new Set());
  };
  const clearAll = () => {
    if (tracksRef.current.length === 0) return;
    tracksRef.current = [];
    selectedRef.current = new Set();
    tableFilterRef.current = "";
    setTracks([]);
    setSelected(new Set());
    setTableFilter("");
  };
  const copySelected = async () => {
    const text = tracks.filter((track) => selected.has(track.id)).map((track) =>
      [track.filename, track.title, track.artist, track.album, track.comment, track.grouping, track.initialKey, track.initialBpm ?? "", track.detectedBpm ?? "", track.detectedCode].join("\t"),
    ).join("\n");
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setNotice(`Copied ${selected.size} row${selected.size === 1 ? "" : "s"}`); }
    catch (error) { setNotice(errorMessage(error)); }
  };
  const persistSettings = async () => {
    if (!settingsDraft) return;
    try {
      await saveSettings(settingsDraft);
      setSettings(settingsDraft);
      void refreshLibraries(settingsDraft);
      setSettingsDraft(null);
      setNotice("Settings saved");
    } catch (error) { setNotice(errorMessage(error)); }
  };

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    listenMenuActions((action) => {
      if (action === "settings") openSettings();
      if (action === "about") void showAbout();
      if (action === "check-updates") void showAbout(true);
    }).then((unlisten) => { if (disposed) unlisten(); else cleanup = unlisten; }).catch(() => undefined);
    return () => { disposed = true; cleanup?.(); };
  }, [tracks, settings, appInfo, openSettings]);

  const completed = tracks.filter((track) => track.status === "completed" && !track.error).length;
  const failed = tracks.filter((track) => track.status === "failed" || !!track.error).length;
  const activeThreads = tracks.filter((track) => track.status === "analyzing").length;
  const canAnalyze = tracks.some((track) => selected.size > 0
    ? selected.has(track.id) && track.status !== "analyzing"
    : !["analyzing", "completed"].includes(track.status));
  const canWrite = tracks.some((track) => (selected.size === 0 || selected.has(track.id))
    && hasWritableResult(track, settings));
  const playlistsEnabled = settings.features.playlistsEnabled;
  const toggleLibrary = () => {
    const nextOpen = !libraryOpen;
    const nextSettings = {
      ...settings,
      presentation: { ...settings.presentation, libraryOpen: nextOpen },
    };
    setLibraryOpen(nextOpen);
    setSettings(nextSettings);
    void saveSettings(nextSettings).catch((error) => setNotice(`Settings: ${errorMessage(error)}`));
  };

  return (
    <div className={`app-shell ${dropHover ? "is-drop-hover" : ""}`}>
      <main id="main" className="workspace">
        <div className={`workspace-grid ${playlistsEnabled && libraryOpen ? "" : "workspace-grid--collapsed"}`}>
          {playlistsEnabled && (
            <LibraryPanel
              playlists={playlists}
              warnings={libraryWarnings}
              busy={busy}
              onRefresh={() => void refreshLibraries()}
              onImport={() => void importPlaylist()}
              onOpen={(playlist) => void openPlaylist(playlist)}
              hidden={!libraryOpen}
            />
          )}
          <div className="batch-column">
        {playlistsEnabled && (
          <div className="table-topbar">
            <button
              className="button ghost library-toggle"
              type="button"
              aria-expanded={libraryOpen}
              aria-controls="library-sidebar"
              onClick={toggleLibrary}
            >
              <SidebarIcon />
              {libraryOpen ? t("library.hidePlaylists") : t("library.showPlaylists")}
            </button>
          </div>
        )}
        <section className="batch-panel" aria-label="Batch controls">
          <div className={`toolbar ${playingTrack ? "toolbar--with-media" : ""}`}>
            <div className="batch-summary-group">
              <div className="batch-stats" aria-label="Batch summary">
                <span><strong>{tracks.length}</strong> tracks</span>
                <span><strong>{completed}</strong> complete</span>
                <span className={failed ? "has-errors" : ""}><strong>{failed}</strong> failed</span>
              </div>
              {tracks.length > 0 && (
                <AddTracksMenu
                  disabled={busy || !!jobId || engine.kind !== "available"}
                  onAddFiles={() => void chooseFiles()}
                  onAddFolders={() => void chooseFolders()}
                />
              )}
            </div>
            {playingTrack && (
              <MediaControls
                track={playingTrack}
                paused={playbackPaused}
                currentTime={playbackTime}
                duration={playbackDuration}
                volume={playbackVolume}
                muted={playbackMuted}
                canPrevious={playbackIndex > 0}
                canNext={playbackIndex >= 0 && playbackIndex < playbackOrder.length - 1}
                onTogglePlayback={() => void togglePlaybackPause()}
                onPrevious={() => playAdjacentTrack(-1)}
                onNext={() => playAdjacentTrack(1)}
                onSeek={seekPlayback}
                onVolume={changePlaybackVolume}
                onToggleMute={togglePlaybackMute}
                onClose={stopPlayback}
              />
            )}
            <div className="toolbar-group toolbar-group--primary">
              {jobId ? (
                <button className="button danger" type="button" onClick={() => void cancel()}>Cancel analysis</button>
              ) : (
                <button className="button primary" type="button" disabled={!canAnalyze || busy || engine.kind !== "available"} onClick={() => void analyze()}>
                  Analyze {selected.size ? `selected (${selected.size})` : "batch"}
                </button>
              )}
              <button className="button secondary" type="button" disabled={!canWrite || busy || !!jobId} onClick={requestWrite}>
                {busy ? "Writing…" : selected.size > 0 ? "Write selected" : "Write analyzed results"}
              </button>
              <ApplicationMenu
                engineUnavailable={engine.kind === "unavailable"}
                onRetryEngine={() => void checkEngine()}
                onNewWindow={() => void newBatchWindow().catch((error) => setNotice(errorMessage(error)))}
                onSettings={openSettings}
                onCheckUpdates={() => void showAbout(true)}
                onAbout={() => void showAbout()}
              />
            </div>
          </div>

          {(jobId || progress.total > 0) && (
            <div
              className={`progress-strip ${!jobId ? "progress-strip--finished" : ""}`}
              aria-label="Analysis progress"
            >
              <div><span style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
              <p>
                {jobId ? `Analyzing · ${activeThreads > 0 ? `${activeThreads} ${activeThreads === 1 ? "thread" : "threads"} active` : "starting threads"}` : "Last run"}
                {` · ${progress.completed} of ${progress.total} · ${Math.round(progress.fraction * 100)}%`}
              </p>
            </div>
          )}

          {tracks.length === 0 ? (
            <div className="empty-state">
              <div className="drop-icon" aria-hidden="true">♫</div>
              <h2>{dropHover ? "Drop to add your music" : "Build your first batch"}</h2>
              <p>Drop audio files or folders here, or choose them from your computer. Folders are scanned recursively.</p>
              <div className="empty-state-actions">
                <button className="button primary" type="button" disabled={busy} onClick={() => void chooseFolders()}>
                  <AddFolderIcon />
                  <span>Add folders</span>
                </button>
                <button className="button secondary" type="button" disabled={busy} onClick={() => void chooseFiles()}>
                  <AddFilesIcon />
                  <span>Add files</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="selection-bar">
                <div className="selection-summary">
                  <span>{selected.size ? `${selected.size} selected` : "Select rows to write or manage them"}</span>
                  <label className="table-search">
                    <SearchIcon />
                    <input
                      type="search"
                      aria-label="Filter tracks"
                      placeholder="Filter tracks"
                      value={tableFilter}
                      onChange={(event) => setTableFilter(event.target.value)}
                    />
                    {tableFilter && (
                      <button type="button" aria-label="Clear track filter" onClick={() => setTableFilter("")}>×</button>
                    )}
                  </label>
                  {tableFilter && <span className="filter-result-count">{filteredTracks.length}/{tracks.length}</span>}
                </div>
                <div>
                  <ColumnSelector
                    columns={orderedColumns}
                    visible={columnLayout.visible}
                    onToggle={toggleColumnVisibility}
                    onShowAll={() => setColumnLayout((current) => ({
                      ...current,
                      visible: [...current.order],
                    }))}
                    onResetWidths={() => setColumnLayout((current) => ({
                      ...current,
                      widths: defaultColumnLayout().widths,
                    }))}
                    onResetOrder={() => setColumnLayout((current) => ({
                      ...current,
                      order: defaultColumnLayout().order,
                    }))}
                  />
                  <button type="button" disabled={!selected.size} onClick={() => void copySelected()}>Copy</button>
                  <button type="button" disabled={!selected.size || !!jobId} onClick={clearResults}>Clear results</button>
                  <button type="button" disabled={!selected.size || !!jobId} onClick={removeSelected}>Remove</button>
                  <button type="button" disabled={!!jobId} onClick={clearAll}>Clear all</button>
                </div>
              </div>
              <TrackTable
                tracks={filteredTracks}
                selected={selected}
                onSelected={setSelected}
                onOpenError={setErrorTrack}
                onPlayTrack={(track) => void toggleTrackPlayback(track)}
                onRevealTrack={(track) => void revealTrackInFolder(track.path)
                  .then(() => setNotice(`Revealed ${track.filename}`))
                  .catch((error) => setNotice(`Could not reveal file: ${errorMessage(error)}`))}
                onRemoveSelected={removeSelected}
                onClearDetectedKeys={clearResults}
                queued={queued}
                sort={sort}
                onSort={setSort}
                visibleColumns={visibleColumns}
                columnWidths={columnLayout.widths}
                onColumnWidthChange={setColumnWidth}
                onColumnReorder={reorderColumn}
                playingTrackId={playingTrackId}
                playbackPaused={playbackPaused}
                compact={settings.presentation.compactRows}
                actionsDisabled={!!jobId || queued.size > 0}
              />
            </>
          )}
        </section>

        <div className="sr-only" role="log" aria-live="polite">
          {notice || (engine.kind === "available" ? `Native engine ${engine.health.engineVersion} ready` : "Waiting for native engine")}
        </div>
          </div>
        </div>
      </main>

      <div className="sr-only" role="status" aria-live="polite">
        {engine.kind === "checking" ? "Checking engine" : engine.kind === "available" ? "Engine online" : "Engine offline"}
      </div>
      {settingsDraft && <SettingsPanel value={settingsDraft} onChange={setSettingsDraft} onClose={() => setSettingsDraft(null)} onSave={() => void persistSettings()} />}
      {aboutOpen && <AboutDialog info={appInfo} update={update} onCheck={() => void checkForUpdates()} onOpen={(url) => void openProjectUrl(url).catch((error) => setNotice(errorMessage(error)))} onClose={() => setAboutOpen(false)} />}
      {errorTrack && <ErrorDialog track={errorTrack} onClose={() => setErrorTrack(null)} />}
      {pendingWrite && (
        <WriteConfirmationDialog
          count={pendingWrite.length}
          writesBpm={settings.outputs.bpm !== "none"}
          writesComment={settings.outputs.comment !== "none"}
          onConfirm={() => void confirmWrite()}
          onClose={() => setPendingWrite(null)}
        />
      )}
      {dropHover && <div className="drop-overlay" aria-hidden="true"><span>Drop files to add</span></div>}
    </div>
  );
}
