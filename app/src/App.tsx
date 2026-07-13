import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cancelAnalysis,
  discoverLibraries,
  expandFiles,
  getAppInfo,
  getNativeHealth,
  listenForFileDrops,
  listenMenuActions,
  listenNativeEvents,
  loadPlaylist,
  loadSettings,
  newBatchWindow,
  openProjectUrl,
  pickAudioFiles,
  pickPlaylistFile,
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
  schemaVersion: 1,
  parallel: true,
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
  "filename" | "title" | "artist" | "album" | "comment" | "grouping" | "initialKey" | "detectedCode"
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
  return [...tracks].sort((a, b) =>
    a[sort.key].localeCompare(b[sort.key], undefined, { numeric: true, sensitivity: "base" }) * sort.direction,
  );
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
          <button type="button" role="menuitem" onClick={() => run(onAbout)}>About Neo KeyFinder</button>
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
                  <span>{field === "initialKey" ? "Initial key" : field}</span>
                  <select
                    aria-label={`${field} output`}
                    value={mode}
                    onChange={(event) => setOutput(field as keyof Settings["outputs"], event.target.value as OutputMode)}
                  >
                    <option value="none">Do not write</option>
                    <option value="prepend">Prepend</option>
                    <option value="append">Append</option>
                    <option value="overwrite">Overwrite</option>
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

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "filename", label: "Filename" },
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "album", label: "Album" },
  { key: "comment", label: "Comment" },
  { key: "grouping", label: "Grouping" },
  { key: "initialKey", label: "Initial key" },
  { key: "detectedCode", label: "Detected key" },
];

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

function TrackTable({
  tracks,
  selected,
  onSelected,
  onOpenError,
  onRemoveSelected,
  onClearDetectedKeys,
  queued,
  sort,
  onSort,
  compact,
  actionsDisabled,
}: {
  tracks: Track[];
  selected: Set<string>;
  onSelected: (next: Set<string>) => void;
  onOpenError: (track: Track) => void;
  onRemoveSelected: () => void;
  onClearDetectedKeys: () => void;
  queued: Set<string>;
  sort: SortState;
  onSort: (sort: SortState) => void;
  compact: boolean;
  actionsDisabled: boolean;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(470);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowHeight = compact ? 36 : 48;
  const sorted = useMemo(() => orderTracks(tracks, sort), [tracks, sort]);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const end = Math.min(sorted.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 5);
  const visible = sorted.slice(start, end);
  const allSelected = tracks.length > 0 && tracks.every((track) => selected.has(track.id));

  const toggleSort = (key: SortKey) => {
    if (!sort || sort.key !== key) onSort({ key, direction: 1 });
    else if (sort.direction === 1) onSort({ key, direction: -1 });
    else onSort(null);
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
    setSelectionAnchorId(track.id);
    onSelected(new Set([track.id]));
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
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
      aria-keyshortcuts="ArrowUp ArrowDown Control+A Meta+A"
      aria-activedescendant={activeId ? `track-row-${activeId}` : undefined}
      tabIndex={0}
      ref={tableRef}
      onKeyDown={handleKeyDown}
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
        {COLUMNS.map((column) => (
          <button
            type="button"
            role="columnheader"
            aria-sort={sort?.key === column.key ? (sort.direction === 1 ? "ascending" : "descending") : "none"}
            onClick={() => toggleSort(column.key)}
            key={column.key}
          >
            {column.label}<span aria-hidden="true">{sort?.key === column.key ? (sort.direction === 1 ? " ↑" : " ↓") : ""}</span>
          </button>
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
        <div style={{ height: start * rowHeight }} aria-hidden="true" />
        {visible.map((track) => {
          const visualStatus = track.error ? "failed" : track.status;
          const isQueued = queued.has(track.id);
          return (
          <div
            id={`track-row-${track.id}`}
            className={`track-row track-row--${visualStatus} ${selected.has(track.id) ? "is-selected" : ""} ${activeId === track.id ? "is-active" : ""} ${isQueued ? "is-queued" : ""}`}
            role="row"
            aria-busy={isQueued}
            style={{ height: rowHeight }}
            title={track.error?.message ?? track.path}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button, input")) return;
              selectRow(track, event);
              tableRef.current?.focus();
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
                y: Math.max(8, Math.min(event.clientY, window.innerHeight - 100)),
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
            {COLUMNS.map((column) => (
              <div className={column.key === "detectedCode" ? "key-cell" : ""} role="gridcell" key={column.key}>
                {column.key === "filename" && <span className={`row-status row-status--${visualStatus}`} aria-label={isQueued ? "queued" : visualStatus} />}
                {column.key === "detectedCode" && track.error ? (
                  <button className="error-details-button" type="button" aria-label={`View error for ${track.filename}`} onClick={() => onOpenError(track)}>View error</button>
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
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ completed: 0, total: 0, fraction: 0 });
  const [busy, setBusy] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [libraryWarnings, setLibraryWarnings] = useState<PlaylistWarning[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [errorTrack, setErrorTrack] = useState<Track | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  const lastSequence = useRef(new Map<string, number>());
  const finishedJobs = useRef(new Set<string>());

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
      setTracks((current) => mergeTracks(current, result.tracks));
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
    listenForFileDrops((paths) => void addPaths(paths), setDropHover)
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
  const openPlaylist = async (playlist: Playlist) => {
    if (tracks.length > 0 && !window.confirm(t("library.replaceWarning"))) return;
    setBusy(true);
    setNotice(`Loading ${playlist.name}…`);
    try {
      const result = await expandFiles(playlist.tracks, settings);
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
    setQueued(new Set(candidates.map((track) => track.id)));
    try {
      setProgress({ completed: 0, total: candidates.length, fraction: 0 });
      const result = await startAnalysis(candidates, settings);
      if (!finishedJobs.current.has(result.jobId)) setJobId(result.jobId);
      setNotice(`Analyzing ${candidates.length} track${candidates.length === 1 ? "" : "s"}`);
    } catch (error) { setQueued(new Set()); setNotice(errorMessage(error)); }
  };
  const cancel = async () => {
    if (!jobId) return;
    try { await cancelAnalysis(jobId); setNotice("Cancelling after the current decode step…"); } catch (error) { setNotice(errorMessage(error)); }
  };
  const writeSelected = async () => {
    const candidates = tracks.filter((track) => selected.has(track.id) && track.detectedKey !== null);
    if (!candidates.length) return;
    setBusy(true);
    try {
      const result = await writeTracks(candidates, settings);
      const updates = new Map(result.tracks.map((track) => [track.id, track]));
      setTracks((current) => current.map((track) => updates.get(track.id) ?? track));
      setNotice(`Wrote ${result.tracks.length} track${result.tracks.length === 1 ? "" : "s"}`);
    } catch (error) { setNotice(errorMessage(error)); } finally { setBusy(false); }
  };
  const clearResults = () => setTracks((current) => current.map((track) => selected.has(track.id) ? {
    ...track, detectedKey: null, detectedCode: "", status: "ready", error: null,
  } : track));
  const removeSelected = () => {
    setTracks((current) => current.filter((track) => !selected.has(track.id)));
    setSelected(new Set());
  };
  const copySelected = async () => {
    const text = tracks.filter((track) => selected.has(track.id)).map((track) =>
      [track.filename, track.title, track.artist, track.album, track.comment, track.grouping, track.initialKey, track.detectedCode].join("\t"),
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
  const canWrite = tracks.some((track) => selected.has(track.id) && track.detectedKey !== null);
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
          <div className="toolbar">
            <div className="batch-stats" aria-label="Batch summary">
              <span><strong>{tracks.length}</strong> tracks</span>
              <span><strong>{completed}</strong> complete</span>
              <span className={failed ? "has-errors" : ""}><strong>{failed}</strong> failed</span>
            </div>
            <div className="toolbar-group toolbar-group--primary">
              {jobId ? (
                <button className="button danger" type="button" onClick={() => void cancel()}>Cancel analysis</button>
              ) : (
                <button className="button primary" type="button" disabled={!canAnalyze || busy || engine.kind !== "available"} onClick={() => void analyze()}>
                  Analyze {selected.size ? `selected (${selected.size})` : "batch"}
                </button>
              )}
              <button className="button secondary" type="button" disabled={!canWrite || busy || !!jobId} onClick={() => void writeSelected()}>Write selected</button>
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
              <button className="button primary" type="button" disabled={busy} onClick={() => void chooseFiles()}>Choose audio files</button>
            </div>
          ) : (
            <>
              <div className="selection-bar">
                <span>{selected.size ? `${selected.size} selected` : "Select rows to write or manage them"}</span>
                <div>
                  <button type="button" disabled={!selected.size} onClick={() => void copySelected()}>Copy</button>
                  <button type="button" disabled={!selected.size || !!jobId} onClick={clearResults}>Clear results</button>
                  <button type="button" disabled={!selected.size || !!jobId} onClick={removeSelected}>Remove</button>
                  <button type="button" disabled={!!jobId} onClick={() => { setTracks([]); setSelected(new Set()); }}>Clear all</button>
                </div>
              </div>
              <TrackTable
                tracks={tracks}
                selected={selected}
                onSelected={setSelected}
                onOpenError={setErrorTrack}
                onRemoveSelected={removeSelected}
                onClearDetectedKeys={clearResults}
                queued={queued}
                sort={sort}
                onSort={setSort}
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
      {dropHover && <div className="drop-overlay" aria-hidden="true"><span>Drop files to add</span></div>}
    </div>
  );
}
