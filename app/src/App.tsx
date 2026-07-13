import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cancelAnalysis,
  expandFiles,
  getNativeHealth,
  listenForFileDrops,
  listenNativeEvents,
  loadSettings,
  pickAudioFiles,
  pickAudioFolder,
  saveSettings,
  startAnalysis,
  writeTracks,
  type NativeHealth,
} from "./lib/native-engine";
import type {
  NativeEvent,
  OutputMode,
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
  libraryPaths: { itunes: "", traktor: "", serato: "" },
  presentation: { compactRows: false, windowWidth: 1120, windowHeight: 760 },
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
              {(["standard", "custom", "combined"] as const).map((notation) => (
                <button
                  type="button"
                  className={value.notation === notation ? "active" : ""}
                  aria-pressed={value.notation === notation}
                  onClick={() => set("notation", notation)}
                  key={notation}
                >
                  {notation}
                </button>
              ))}
            </div>
            {value.notation !== "standard" && (
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

function TrackTable({
  tracks,
  selected,
  onSelected,
  compact,
}: {
  tracks: Track[];
  selected: Set<string>;
  onSelected: (next: Set<string>) => void;
  compact: boolean;
}) {
  const [sort, setSort] = useState<{ key: SortKey; direction: 1 | -1 }>({ key: "filename", direction: 1 });
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = compact ? 36 : 48;
  const sorted = useMemo(() => [...tracks].sort((a, b) =>
    a[sort.key].localeCompare(b[sort.key], undefined, { numeric: true, sensitivity: "base" }) * sort.direction,
  ), [tracks, sort]);
  const viewportHeight = 470;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const end = Math.min(sorted.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 5);
  const visible = sorted.slice(start, end);
  const allSelected = tracks.length > 0 && tracks.every((track) => selected.has(track.id));

  const toggleSort = (key: SortKey) => setSort((current) => ({
    key,
    direction: current.key === key ? (current.direction === 1 ? -1 : 1) : 1,
  }));

  return (
    <div className={`track-table ${compact ? "track-table--compact" : ""}`} role="grid" aria-label="Audio tracks">
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
            aria-sort={sort.key === column.key ? (sort.direction === 1 ? "ascending" : "descending") : "none"}
            onClick={() => toggleSort(column.key)}
            key={column.key}
          >
            {column.label}<span aria-hidden="true">{sort.key === column.key ? (sort.direction === 1 ? " ↑" : " ↓") : ""}</span>
          </button>
        ))}
      </div>
      <div className="track-viewport" style={{ height: viewportHeight }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <div style={{ height: start * rowHeight }} aria-hidden="true" />
        {visible.map((track) => (
          <div
            className={`track-row track-row--${track.status} ${selected.has(track.id) ? "is-selected" : ""}`}
            role="row"
            style={{ height: rowHeight }}
            title={track.error?.message ?? track.path}
            key={track.id}
          >
            <div className="select-cell" role="gridcell">
              <input
                type="checkbox"
                aria-label={`Select ${track.filename}`}
                checked={selected.has(track.id)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(track.id); else next.delete(track.id);
                  onSelected(next);
                }}
              />
            </div>
            {COLUMNS.map((column) => (
              <div className={column.key === "detectedCode" ? "key-cell" : ""} role="gridcell" key={column.key}>
                {column.key === "filename" && <span className={`row-status row-status--${track.status}`} aria-label={track.status} />}
                <span>{track[column.key] || "—"}</span>
              </div>
            ))}
          </div>
        ))}
        <div style={{ height: Math.max(0, (sorted.length - end) * rowHeight) }} aria-hidden="true" />
      </div>
    </div>
  );
}

export default function App() {
  const [engine, setEngine] = useState<EngineState>({ kind: "checking" });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ completed: 0, total: 0, fraction: 0 });
  const [busy, setBusy] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [notice, setNotice] = useState<string>("");
  const lastSequence = useRef(new Map<string, number>());
  const finishedJobs = useRef(new Set<string>());

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

  useEffect(() => {
    void checkEngine();
    loadSettings().then(setSettings).catch((error) => setNotice(`Settings: ${errorMessage(error)}`));
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
  const chooseFolder = async () => {
    try { const folder = await pickAudioFolder(); if (folder) await addPaths([folder]); } catch (error) { setNotice(errorMessage(error)); }
  };
  const analyze = async () => {
    const candidates = tracks.filter((track) =>
      (selected.size === 0 || selected.has(track.id)) && !["analyzing", "completed"].includes(track.status),
    );
    if (!candidates.length) return;
    try {
      setProgress({ completed: 0, total: candidates.length, fraction: 0 });
      const result = await startAnalysis(candidates, settings);
      if (!finishedJobs.current.has(result.jobId)) setJobId(result.jobId);
      setNotice(`Analyzing ${candidates.length} track${candidates.length === 1 ? "" : "s"}`);
    } catch (error) { setNotice(errorMessage(error)); }
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
      setSettingsDraft(null);
      setNotice("Settings saved");
    } catch (error) { setNotice(errorMessage(error)); }
  };

  const completed = tracks.filter((track) => track.status === "completed").length;
  const failed = tracks.filter((track) => track.status === "failed").length;
  const canAnalyze = tracks.some((track) =>
    (selected.size === 0 || selected.has(track.id)) &&
    !["analyzing", "completed"].includes(track.status),
  );
  const canWrite = tracks.some((track) => selected.has(track.id) && track.detectedKey !== null);

  return (
    <div className={`app-shell ${dropHover ? "is-drop-hover" : ""}`}>
      <header className="topbar">
        <div className="brand" aria-label="KeyFinder">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>KeyFinder</span>
        </div>
        <div className="topbar-actions">
          <div className={`engine-pill engine-pill--${engine.kind}`} role="status" aria-live="polite" title={engine.kind === "unavailable" ? engine.message : "Native analysis engine"}>
            <span className="status-dot" aria-hidden="true" />
            {engine.kind === "checking" ? "Checking engine" : engine.kind === "available" ? "Engine online" : "Engine offline"}
          </div>
          {engine.kind === "unavailable" && <button className="button ghost" type="button" onClick={() => void checkEngine()}>Retry engine</button>}
          <button className="button ghost" type="button" onClick={() => setSettingsDraft(structuredClone(settings))}>Settings</button>
        </div>
      </header>

      <main id="main" className="workspace">
        <section className="workspace-heading">
          <div>
            <p className="eyebrow">Batch workspace</p>
            <h1>Find the key. <span>Keep the flow.</span></h1>
          </div>
          <div className="batch-stats" aria-label="Batch summary">
            <span><strong>{tracks.length}</strong> tracks</span>
            <span><strong>{completed}</strong> complete</span>
            <span className={failed ? "has-errors" : ""}><strong>{failed}</strong> failed</span>
          </div>
        </section>

        <section className="batch-panel" aria-label="Batch controls">
          <div className="toolbar">
            <div className="toolbar-group">
              <button className="button secondary" type="button" disabled={busy || !!jobId} onClick={() => void chooseFiles()}>+ Add files</button>
              <button className="button secondary" type="button" disabled={busy || !!jobId} onClick={() => void chooseFolder()}>+ Add folder</button>
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
            </div>
          </div>

          {(jobId || progress.total > 0) && (
            <div className="progress-strip" aria-label="Analysis progress">
              <div><span style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
              <p>{jobId ? "Analyzing" : "Last run"} · {progress.completed} of {progress.total} · {Math.round(progress.fraction * 100)}%</p>
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
              <TrackTable tracks={tracks} selected={selected} onSelected={setSelected} compact={settings.presentation.compactRows} />
            </>
          )}
        </section>

        <div className="status-line" role="log" aria-live="polite">
          <span className={busy ? "pulse" : ""} />
          {notice || (engine.kind === "available" ? `Native engine ${engine.health.engineVersion} ready` : "Waiting for native engine")}
        </div>
      </main>

      {settingsDraft && <SettingsPanel value={settingsDraft} onChange={setSettingsDraft} onClose={() => setSettingsDraft(null)} onSave={() => void persistSettings()} />}
      {dropHover && <div className="drop-overlay" aria-hidden="true"><span>Drop files to add</span></div>}
    </div>
  );
}
