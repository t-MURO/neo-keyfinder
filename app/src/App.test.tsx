import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as native from "./lib/native-engine";
import type { NativeEvent, Playlist, Settings, Track } from "./lib/types";

vi.mock("./lib/native-engine", () => ({
  getNativeHealth: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  pickAudioFiles: vi.fn(),
  pickAudioFolders: vi.fn(),
  prepareAudioPlayback: vi.fn(),
  revealTrackInFolder: vi.fn(),
  getAudioWaveform: vi.fn(),
  expandFiles: vi.fn(),
  startAnalysis: vi.fn(),
  cancelAnalysis: vi.fn(),
  writeTracks: vi.fn(),
  discoverLibraries: vi.fn(),
  loadPlaylist: vi.fn(),
  pickPlaylistFile: vi.fn(),
  newBatchWindow: vi.fn(),
  getAppInfo: vi.fn(),
  openProjectUrl: vi.fn(),
  listenMenuActions: vi.fn(),
  listenNativeEvents: vi.fn(),
  listenForFileDrops: vi.fn(),
}));

const settings: Settings = {
  schemaVersion: 2,
  parallel: true,
  bpmAnalysisEnabled: true,
  maxDurationMinutes: 60,
  skipExisting: false,
  automaticWrites: false,
  extensionFilterEnabled: false,
  extensions: ["mp3", "flac", "wav"],
  outputs: { title: "none", artist: "none", album: "none", comment: "prepend", grouping: "none", initialKey: "none", bpm: "none", filename: "none" },
  delimiter: " - ",
  notation: "standard",
  customCodes: Array.from({ length: 25 }, () => ""),
  features: { playlistsEnabled: false },
  libraryPaths: { itunes: "", traktor: "", serato: "" },
  presentation: { compactRows: false, libraryOpen: true, windowWidth: 1120, windowHeight: 760 },
  legacyMigrationCompleted: true,
};

const playlistSettings: Settings = {
  ...settings,
  features: { playlistsEnabled: true },
};

const track: Track = {
  id: "track-1",
  path: "/Music/Orbital - Halcyon.flac",
  filename: "Orbital - Halcyon.flac",
  title: "Halcyon + On + On",
  artist: "Orbital",
  album: "Orbital 2",
  comment: "",
  grouping: "",
  initialKey: "",
  initialBpm: 123.5,
  durationMs: 452000,
  detectedKey: null,
  detectedCode: "",
  detectedBpm: null,
  status: "ready",
  error: null,
};

let eventHandler: ((event: NativeEvent) => void) | undefined;
let fileDropHandler: ((paths: string[]) => void) | undefined;
let fileDropHoverHandler: ((hovering: boolean) => void) | undefined;

afterEach(cleanup);

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storedValues = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storedValues.get(key) ?? null,
        setItem: (key: string, value: string) => storedValues.set(key, value),
        removeItem: (key: string) => storedValues.delete(key),
        clear: () => storedValues.clear(),
      },
    });
    eventHandler = undefined;
    fileDropHandler = undefined;
    fileDropHoverHandler = undefined;
    vi.mocked(native.getNativeHealth).mockResolvedValue({ service: "keyfinder-native", engineVersion: "0.1.0", protocolVersion: 1 });
    vi.mocked(native.loadSettings).mockResolvedValue(settings);
    vi.mocked(native.saveSettings).mockResolvedValue();
    vi.mocked(native.pickAudioFiles).mockResolvedValue([]);
    vi.mocked(native.pickAudioFolders).mockResolvedValue([]);
    vi.mocked(native.prepareAudioPlayback).mockResolvedValue("asset://localhost/audio.flac");
    vi.mocked(native.revealTrackInFolder).mockResolvedValue();
    vi.mocked(native.getAudioWaveform).mockResolvedValue([0.2, 0.8, 0.4, 1]);
    vi.mocked(native.pickPlaylistFile).mockResolvedValue(null);
    vi.mocked(native.discoverLibraries).mockResolvedValue({ playlists: [], warnings: [] });
    vi.mocked(native.newBatchWindow).mockResolvedValue("batch-1");
    vi.mocked(native.getAppInfo).mockResolvedValue({
      name: "NeoKeyAndBpmFinder",
      version: "0.1.0",
      projectUrl: "https://github.com/t-MURO/neo-keyfinder",
      releaseApiUrl: "https://github.com/t-MURO/neo-keyfinder/releases/latest",
      releaseMetadataUrl: "https://api.github.com/repos/t-MURO/neo-keyfinder/releases/latest",
    });
    vi.mocked(native.listenMenuActions).mockResolvedValue(() => undefined);
    vi.mocked(native.listenForFileDrops).mockImplementation(async (handler, setHovering) => {
      fileDropHandler = handler;
      fileDropHoverHandler = setHovering;
      return () => undefined;
    });
    vi.mocked(native.listenNativeEvents).mockImplementation(async (handler) => {
      eventHandler = handler;
      return () => undefined;
    });
  });

  it("shows an online engine and an actionable empty batch", async () => {
    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("Checking engine");
    expect(await screen.findByText("Engine online")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Build your first batch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add files" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add folders" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("adds picker results and exposes metadata in the batch table", async () => {
    const user = userEvent.setup();
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track], warnings: [] });
    render(<App />);

    await screen.findByText("Engine online");
    await user.click(screen.getByRole("button", { name: "Add files" }));

    expect(await screen.findByText(track.filename)).toBeInTheDocument();
    expect(screen.getByText(track.title)).toBeInTheDocument();
    expect(screen.getByText(track.artist)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /^BPM tag/ })).toBeInTheDocument();
    expect(screen.getByText("123.5")).toBeInTheDocument();
    expect(native.expandFiles).toHaveBeenCalledWith([track.path], settings);
  });

  it("recursively expands multiple chosen folders through one audio intake", async () => {
    const user = userEvent.setup();
    const folders = ["/Music/Orbital", "/Music/Underworld", "/Music/Leftfield"];
    const legacyTrack: Partial<Track> = { ...track };
    delete legacyTrack.initialBpm;
    delete legacyTrack.detectedBpm;
    vi.mocked(native.pickAudioFolders).mockResolvedValue(folders);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [legacyTrack as Track], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add folders" }));

    expect(native.pickAudioFolders).toHaveBeenCalledOnce();
    expect(native.expandFiles).toHaveBeenCalledWith(folders, settings);
    expect(await screen.findByText(track.filename)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /^BPM tag/ })).toBeInTheDocument();
  });

  it("offers one add menu next to the batch summary after the first import", async () => {
    const user = userEvent.setup();
    const second = { ...track, id: "track-2", path: "/Music/Second.wav", filename: "Second.wav" };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValueOnce({ tracks: [track], warnings: [] });
    render(<App />);

    expect(screen.queryByRole("button", { name: "Add more songs" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Add files" }));

    const addMore = await screen.findByRole("button", { name: "Add more songs" });
    expect(addMore.closest(".batch-summary-group")).toContainElement(screen.getByLabelText("Batch summary"));
    await user.click(addMore);
    const menu = screen.getByRole("menu", { name: "Add tracks" });
    expect(within(menu).getByRole("menuitem", { name: "Add files" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Add folders" })).toBeInTheDocument();

    vi.mocked(native.pickAudioFiles).mockResolvedValue([second.path]);
    vi.mocked(native.expandFiles).mockResolvedValueOnce({ tracks: [second], warnings: [] });
    await user.click(within(menu).getByRole("menuitem", { name: "Add files" }));

    expect(await screen.findByText(second.filename)).toBeInTheDocument();
    expect(screen.getByLabelText("Batch summary")).toHaveTextContent(/2 tracks/);
  });

  it("starts a job and applies ordered sidecar events to the row", async () => {
    const user = userEvent.setup();
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track], warnings: [] });
    vi.mocked(native.startAnalysis).mockResolvedValue({ jobId: "job-1" });
    render(<App />);
    await screen.findByText("Engine online");
    await user.click(screen.getByRole("button", { name: "Add files" }));
    await screen.findByText(track.filename);
    await user.click(screen.getByRole("button", { name: "Analyze batch" }));
    expect(screen.getByText(track.filename).closest("[role='row']")).toHaveClass("is-queued");

    const analyzing = { ...track, status: "analyzing" as const };
    act(() => {
      eventHandler?.({ version: 1, event: "trackUpdated", jobId: "job-1", sequence: 1, payload: { track: analyzing } });
    });
    expect(screen.getByText(track.filename).closest("[role='row']")).toHaveClass("track-row--analyzing");
    expect(screen.getByText(track.filename).closest("[role='row']")).not.toHaveClass("is-queued");
    expect(screen.getByText(/Analyzing · 1 thread active/)).toBeInTheDocument();

    const completed = { ...track, detectedKey: 6, detectedCode: "C", detectedBpm: 128.4, status: "completed" as const };
    act(() => {
      eventHandler?.({ version: 1, event: "trackUpdated", jobId: "job-1", sequence: 2, payload: { track: completed } });
      eventHandler?.({ version: 1, event: "jobProgress", jobId: "job-1", sequence: 3, payload: { completed: 1, total: 1, fraction: 1 } });
      eventHandler?.({ version: 1, event: "jobFinished", jobId: "job-1", sequence: 4, payload: { cancelled: false, completed: 1, total: 1 } });
    });

    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByText("128.4")).toBeInTheDocument();
    expect(screen.getByText(track.filename).closest("[role='row']")).toHaveClass("track-row--completed");
    expect(screen.getByRole("log")).toHaveTextContent("Analysis complete");
    expect(screen.getByText(/Last run · 1 of 1 · 100%/).closest(".progress-strip")).toHaveClass("progress-strip--finished");
  });

  it("queues analysis in the current displayed sort order", async () => {
    const user = userEvent.setup();
    const alpha = { ...track, id: "track-alpha", path: "/Music/Alpha.wav", filename: "Alpha.wav", title: "Alpha" };
    const zulu = { ...track, id: "track-zulu", path: "/Music/Zulu.wav", filename: "Zulu.wav", title: "Zulu" };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([zulu.path, alpha.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [zulu, alpha], warnings: [] });
    vi.mocked(native.startAnalysis).mockResolvedValue({ jobId: "job-sorted" });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    await user.click(await screen.findByRole("columnheader", { name: /^Title/ }));
    await user.click(screen.getByRole("button", { name: "Analyze batch" }));

    expect(native.startAnalysis).toHaveBeenCalledWith([alpha, zulu], settings, false);
    expect(screen.getByText("Alpha.wav").closest("[role='row']")).toHaveClass("is-queued");
    expect(screen.getByText("Zulu.wav").closest("[role='row']")).toHaveClass("is-queued");
  });

  it("requires explicit confirmation before authorizing automatic file writes", async () => {
    const user = userEvent.setup();
    const automaticSettings = { ...settings, automaticWrites: true };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(native.loadSettings).mockResolvedValue(automaticSettings);
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track], warnings: [] });
    vi.mocked(native.startAnalysis).mockResolvedValue({ jobId: "job-authorized" });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    await user.click(screen.getByRole("button", { name: "Analyze batch" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("will modify"));
    expect(native.startAnalysis).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Analyze batch" }));
    expect(native.startAnalysis).toHaveBeenCalledWith([track], automaticSettings, true);
    confirm.mockRestore();
  });

  it("colors failed rows with the error state", async () => {
    const user = userEvent.setup();
    const failed = {
      ...track,
      status: "failed" as const,
      error: { code: "ANALYSIS_FAILED", stage: "analysis", message: "Could not decode" },
    };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [failed], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));

    expect((await screen.findByText(track.filename)).closest("[role='row']")).toHaveClass("track-row--failed");
    await user.click(screen.getByRole("button", { name: `View error for ${track.filename}` }));
    const dialog = screen.getByRole("dialog", { name: `Couldn’t process ${track.filename}` });
    expect(within(dialog).getByText("ANALYSIS_FAILED")).toBeInTheDocument();
    expect(within(dialog).getByText("Could not decode")).toBeInTheDocument();
    expect(within(dialog).getByText(track.path)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: `Couldn’t process ${track.filename}` })).not.toBeInTheDocument();
  });

  it("persists output preferences from the settings panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Engine online");
    fireEvent.keyDown(window, { key: ",", metaKey: true });

    const dialog = screen.getByRole("dialog", { name: "Analysis & output" });
    await user.click(within(dialog).getByRole("checkbox", { name: /^BPM analysis/ }));
    await user.selectOptions(within(dialog).getByLabelText("initialKey output"), "overwrite");
    const bpmOutput = within(dialog).getByLabelText("bpm output") as HTMLSelectElement;
    expect(Array.from(bpmOutput.options, (option) => option.value)).toEqual(["none", "overwrite"]);
    await user.selectOptions(bpmOutput, "overwrite");
    await user.click(within(dialog).getByRole("button", { name: "DJ Notation + Key" }));
    await user.clear(within(dialog).getByLabelText("Separator"));
    await user.type(within(dialog).getByLabelText("Separator"), " / ");
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));

    expect(native.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      notation: "djCombined",
      delimiter: " / ",
      bpmAnalysisEnabled: false,
      outputs: expect.objectContaining({ initialKey: "overwrite", bpm: "overwrite" }),
    }));
  });

  it("keeps playlists hidden until the experimental feature is enabled", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Engine online");

    expect(screen.queryByRole("complementary", { name: "Libraries" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show playlists" })).not.toBeInTheDocument();
    expect(native.discoverLibraries).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    const dialog = screen.getByRole("dialog", { name: "Analysis & output" });
    await user.click(within(dialog).getByRole("checkbox", { name: /^Playlist libraries/ }));
    expect(within(dialog).getByLabelText("iTunes XML")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));

    expect(native.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      features: { playlistsEnabled: true },
    }));
    expect(await screen.findByRole("complementary", { name: "Libraries" })).toBeInTheDocument();
  });

  it("supports selection, copy, clear, manual write, and removal", async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    const completed = { ...track, detectedKey: 6, detectedCode: "C", status: "completed" as const };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [completed], warnings: [] });
    vi.mocked(native.writeTracks).mockResolvedValue({ tracks: [{ ...completed, comment: "written" }] });
    render(<App />);
    await screen.findByText("Engine online");
    await user.click(screen.getByRole("button", { name: "Add files" }));
    await user.click(await screen.findByRole("checkbox", { name: `Select ${track.filename}` }));

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("Halcyon + On + On"));

    await user.click(screen.getByRole("button", { name: "Write selected" }));
    const writeDialog = screen.getByRole("dialog", { name: "Write metadata to 1 file?" });
    await user.click(within(writeDialog).getByRole("button", { name: "Write 1 file" }));
    expect(native.writeTracks).toHaveBeenCalledWith([completed], settings);

    await user.click(screen.getByRole("button", { name: "Clear results" }));
    expect(screen.queryByText("C")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("heading", { name: "Build your first batch" })).toBeInTheDocument();
  });

  it("writes detected BPM for analyzed results without requiring row selection", async () => {
    const user = userEvent.setup();
    const bpmSettings: Settings = {
      ...settings,
      outputs: {
        title: "none", artist: "none", album: "none", comment: "none",
        grouping: "none", initialKey: "none", bpm: "overwrite", filename: "none",
      },
    };
    const analyzed = {
      ...track,
      detectedBpm: 128.4,
      status: "completed" as const,
    };
    vi.mocked(native.loadSettings).mockResolvedValue(bpmSettings);
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [analyzed], warnings: [] });
    vi.mocked(native.writeTracks).mockResolvedValue({ tracks: [{ ...analyzed, initialBpm: 128 }] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    const write = await screen.findByRole("button", { name: "Write analyzed results" });
    expect(write).toBeEnabled();
    await user.click(write);
    const writeDialog = screen.getByRole("dialog", { name: "Write metadata to 1 file?" });
    expect(within(writeDialog).getByText(/dedicated BPM tag/)).toBeInTheDocument();
    expect(within(writeDialog).getByText(/Comment tags will not be changed/)).toBeInTheDocument();
    await user.click(within(writeDialog).getByRole("button", { name: "Write 1 file" }));

    expect(native.writeTracks).toHaveBeenCalledWith([analyzed], bpmSettings);
  });

  it("allows an explicitly selected completed track to be analyzed again", async () => {
    const user = userEvent.setup();
    const completed = { ...track, detectedKey: 6, detectedCode: "C", status: "completed" as const };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [completed], warnings: [] });
    vi.mocked(native.startAnalysis).mockResolvedValue({ jobId: "job-repeat" });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    expect(screen.getByRole("button", { name: "Analyze batch" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: `Select ${track.filename}` }));
    const analyzeSelected = screen.getByRole("button", { name: "Analyze selected (1)" });
    expect(analyzeSelected).toBeEnabled();
    await user.click(analyzeSelected);

    expect(native.startAnalysis).toHaveBeenCalledWith([completed], settings, false);
  });

  it("navigates rows with arrow keys and selects all with the platform shortcut", async () => {
    const user = userEvent.setup();
    const second = { ...track, id: "track-2", path: "/Music/Second.wav", filename: "Second.wav" };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path, second.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track, second], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    const table = await screen.findByRole("grid", { name: "Audio tracks" });
    table.focus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("checkbox", { name: `Select ${track.filename}` })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: `Select ${second.filename}` })).not.toBeChecked();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("checkbox", { name: `Select ${track.filename}` })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: `Select ${second.filename}` })).toBeChecked();

    await user.keyboard("{Control>}a{/Control}");
    expect(screen.getByRole("checkbox", { name: `Select ${track.filename}` })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: `Select ${second.filename}` })).toBeChecked();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("supports range selection and additive row clicks", async () => {
    const user = userEvent.setup();
    const second = { ...track, id: "track-2", path: "/Music/Second.wav", filename: "Second.wav" };
    const third = { ...track, id: "track-3", path: "/Music/Third.wav", filename: "Third.wav" };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path, second.path, third.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track, second, third], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    const firstRow = screen.getByText(track.filename).closest("[role='row']") as HTMLElement;
    const secondRow = screen.getByText(second.filename).closest("[role='row']") as HTMLElement;
    const thirdRow = screen.getByText(third.filename).closest("[role='row']") as HTMLElement;

    await user.click(firstRow);
    fireEvent.click(thirdRow, { shiftKey: true });
    expect(screen.getByText("3 selected")).toBeInTheDocument();

    fireEvent.click(secondRow, { ctrlKey: true });
    expect(screen.getByRole("checkbox", { name: `Select ${track.filename}` })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: `Select ${second.filename}` })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: `Select ${third.filename}` })).toBeChecked();
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await user.click(thirdRow);
    expect(screen.getByRole("checkbox", { name: `Select ${track.filename}` })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: `Select ${third.filename}` })).not.toBeChecked();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("offers selected-row actions from the row context menu", async () => {
    const user = userEvent.setup();
    const first = { ...track, detectedKey: 6, detectedCode: "C", status: "completed" as const };
    const second = {
      ...first,
      id: "track-2",
      path: "/Music/Second.wav",
      filename: "Second.wav",
    };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([first.path, second.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [first, second], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    const secondRow = (await screen.findByText(second.filename)).closest("[role='row']") as HTMLElement;
    fireEvent.contextMenu(secondRow, { clientX: 120, clientY: 180 });

    const clearMenu = screen.getByRole("menu", { name: "Selected row actions" });
    expect(screen.getByRole("checkbox", { name: `Select ${second.filename}` })).toBeChecked();
    await user.click(within(clearMenu).getByRole("menuitem", { name: /Show in/ }));
    expect(native.revealTrackInFolder).toHaveBeenCalledWith(second.path);

    fireEvent.contextMenu(secondRow, { clientX: 120, clientY: 180 });
    const reopenedMenu = screen.getByRole("menu", { name: "Selected row actions" });
    await user.click(within(reopenedMenu).getByRole("menuitem", { name: "Clear detected keys" }));
    expect(secondRow.querySelector(".key-cell")).toHaveTextContent("—");
    expect(screen.getByText(first.filename).closest("[role='row']")?.querySelector(".key-cell")).toHaveTextContent("C");

    const firstRow = screen.getByText(first.filename).closest("[role='row']") as HTMLElement;
    fireEvent.contextMenu(firstRow, { clientX: 120, clientY: 180 });
    await user.click(screen.getByRole("menuitem", { name: "Remove selected rows" }));

    expect(screen.queryByText(first.filename)).not.toBeInTheDocument();
    expect(screen.getByText(second.filename)).toBeInTheDocument();
  });

  it("controls track playback from the context menu and floating player", async () => {
    const user = userEvent.setup();
    const play = vi.fn().mockResolvedValue(undefined);
    const pause = vi.fn();
    Object.defineProperty(window.HTMLMediaElement.prototype, "play", { configurable: true, value: play });
    Object.defineProperty(window.HTMLMediaElement.prototype, "pause", { configurable: true, value: pause });
    Object.defineProperty(window.HTMLMediaElement.prototype, "duration", { configurable: true, get: () => 240 });
    const second = { ...track, id: "track-2", path: "/Music/Second.wav", filename: "Second.wav", title: "Second" };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path, second.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track, second], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    const row = screen.getByText(track.filename).closest("[role='row']") as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 120, clientY: 180 });
    await user.click(screen.getByRole("menuitem", { name: "Play" }));

    expect(native.prepareAudioPlayback).toHaveBeenCalledWith(track.path);
    await waitFor(() => expect(native.getAudioWaveform).toHaveBeenCalledWith(track.path, 96));
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(row).toHaveClass("is-playing");
    const controls = screen.getByRole("region", { name: "Media controls" });
    await waitFor(() => expect(controls.querySelector(".media-waveform-progress")).toBeInTheDocument());
    expect(controls.closest(".toolbar")).toHaveClass("toolbar", "toolbar--with-media");
    const controlsRect = vi.spyOn(controls, "getBoundingClientRect").mockReturnValue({
      x: 300,
      y: 20,
      left: 300,
      top: 20,
      right: 700,
      bottom: 49,
      width: 400,
      height: 29,
      toJSON: () => undefined,
    });
    fireEvent.pointerDown(controls, { pointerId: 1, button: 0, clientX: 350, clientY: 35 });
    fireEvent.pointerMove(controls, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(controls, { pointerId: 1, clientX: 400, clientY: 300 });
    expect(controls).toHaveClass("is-floating");
    expect(controls).toHaveStyle({ left: "350px", top: "285px" });
    expect(JSON.parse(window.localStorage.getItem("neo-keyfinder.media-position.v1") ?? "null")).toEqual({ x: 350, y: 285 });
    controlsRect.mockReturnValue({
      x: 350,
      y: 285,
      left: 350,
      top: 285,
      right: 750,
      bottom: 314,
      width: 400,
      height: 29,
      toJSON: () => undefined,
    });
    vi.spyOn(controls.parentElement as HTMLElement, "getBoundingClientRect").mockReturnValue({
      x: 300,
      y: 20,
      left: 300,
      top: 20,
      right: 700,
      bottom: 49,
      width: 400,
      height: 29,
      toJSON: () => undefined,
    });
    vi.spyOn(controls.closest(".toolbar") as HTMLElement, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1024,
      bottom: 70,
      width: 1024,
      height: 70,
      toJSON: () => undefined,
    });
    fireEvent.pointerDown(controls, { pointerId: 2, button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(controls, { pointerId: 2, clientX: 100, clientY: 35 });
    expect(controls.parentElement).toHaveClass("is-snap-target");
    expect(controls).toHaveClass("is-over-dock");
    fireEvent.pointerUp(controls, { pointerId: 2, clientX: 100, clientY: 35 });
    expect(controls).not.toHaveClass("is-floating");
    expect(controls.parentElement).toHaveClass("has-snapped");
    expect(window.localStorage.getItem("neo-keyfinder.media-position.v1")).toBeNull();
    expect(within(controls).getByRole("button", { name: "Previous track" })).toBeDisabled();
    expect(within(controls).getByRole("button", { name: "Next track" })).toBeEnabled();
    fireEvent.change(within(controls).getByRole("slider", { name: "Seek" }), { target: { value: "30" } });
    expect(within(controls).getByRole("slider", { name: "Seek" })).toHaveValue("30");
    fireEvent.change(within(controls).getByRole("slider", { name: "Playback volume" }), { target: { value: "0.35" } });
    expect(within(controls).getByRole("slider", { name: "Playback volume" })).toHaveValue("0.35");
    await user.click(within(controls).getByRole("button", { name: "Mute" }));
    expect(within(controls).getByRole("button", { name: "Unmute" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(pause).toHaveBeenCalledOnce();
    expect(row).toHaveClass("is-playing", "is-playback-paused");
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(row).not.toHaveClass("is-playback-paused");

    fireEvent.doubleClick(row);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(row).toHaveClass("is-playback-paused");
    fireEvent.doubleClick(row);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(3));

    await user.click(within(controls).getByRole("button", { name: "Next track" }));
    await waitFor(() => expect(native.prepareAudioPlayback).toHaveBeenLastCalledWith(second.path));
    const nextControls = screen.getByRole("region", { name: "Media controls" });
    expect(within(nextControls).getByText("Second - Orbital")).toBeInTheDocument();
    const closePlayer = within(nextControls).getByRole("button", { name: "Close media player" });
    expect(closePlayer).toHaveAttribute("title", "Close media player");
    expect(closePlayer.querySelector(".media-close-icon")).toBeInTheDocument();
    await user.click(closePlayer);
    expect(screen.queryByRole("region", { name: "Media controls" })).not.toBeInTheDocument();
  });

  it("cancels an active batch and resets column sorting on the third click", async () => {
    const user = userEvent.setup();
    const second = { ...track, id: "track-2", path: "/Music/A.wav", filename: "A.wav", title: "Alpha" };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path, second.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track, second], warnings: [] });
    vi.mocked(native.startAnalysis).mockResolvedValue({ jobId: "job-2" });
    vi.mocked(native.cancelAnalysis).mockResolvedValue({ cancelled: true });
    render(<App />);
    await screen.findByText("Engine online");
    await user.click(screen.getByRole("button", { name: "Add files" }));

    const titleHeader = await screen.findByRole("columnheader", { name: /^Title/ });
    await user.click(titleHeader);
    expect(titleHeader).toHaveAttribute("aria-sort", "ascending");
    await user.click(titleHeader);
    expect(titleHeader).toHaveAttribute("aria-sort", "descending");
    await user.click(titleHeader);
    expect(titleHeader).toHaveAttribute("aria-sort", "none");

    await user.click(screen.getByRole("button", { name: "Analyze batch" }));
    await user.click(screen.getByRole("button", { name: "Cancel analysis" }));
    expect(native.cancelAnalysis).toHaveBeenCalledWith("job-2");
    expect(screen.getByRole("log")).toHaveTextContent("Cancelling after the current decode step");
  });

  it("selects, resizes, and sorts visible table columns", async () => {
    const user = userEvent.setup();
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    const table = screen.getByRole("grid", { name: "Audio tracks" });
    Object.defineProperty(table, "clientWidth", { configurable: true, value: 600 });
    Object.defineProperty(table, "scrollWidth", { configurable: true, value: 1200 });
    fireEvent.wheel(table, { deltaX: 80 });
    expect(table.scrollLeft).toBe(80);
    fireEvent.wheel(table, { deltaY: 120, shiftKey: true });
    expect(table.scrollLeft).toBe(200);
    fireEvent.keyDown(table, { key: "ArrowRight", shiftKey: true });
    expect(table.scrollLeft).toBe(300);
    await user.click(screen.getByRole("button", { name: "Choose table columns" }));
    const columnsMenu = screen.getByRole("menu", { name: "Table columns" });
    await user.click(within(columnsMenu).getByRole("checkbox", { name: "Album" }));

    expect(screen.queryByRole("columnheader", { name: /^Album/ })).not.toBeInTheDocument();
    expect(screen.queryByText(track.album)).not.toBeInTheDocument();

    const filenameHeader = screen.getByRole("columnheader", { name: /^Filename/ });
    const resizeHandle = screen.getByRole("separator", { name: "Resize Filename column" });
    fireEvent.pointerDown(resizeHandle, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 });
    fireEvent.pointerUp(window);
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "290");

    await user.click(filenameHeader);
    expect(filenameHeader).toHaveAttribute("aria-sort", "ascending");
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("neo-keyfinder.table-layout.v1") ?? "null");
      expect(stored.visible).not.toContain("album");
      expect(stored.widths.filename).toBe(290);
    });
  });

  it("filters table rows across track values", async () => {
    const user = userEvent.setup();
    const second = { ...track, id: "track-2", path: "/Music/Second.wav", filename: "Second.wav", title: "Second", artist: "Other Artist", detectedBpm: 128 };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path, second.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track, second], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    const filter = screen.getByRole("searchbox", { name: "Filter tracks" });
    await user.type(filter, "other 128");
    expect(screen.queryByText(track.filename)).not.toBeInTheDocument();
    expect(screen.getByText(second.filename)).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, "no-such-track");
    expect(screen.getByText("No tracks match this filter")).toHaveAttribute("role", "status");
    await user.click(screen.getByRole("button", { name: "Clear track filter" }));
    expect(screen.getByText(track.filename)).toBeInTheDocument();
    expect(screen.getByText(second.filename)).toBeInTheDocument();
  });

  it("adds the BPM tag to an existing saved column layout", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("neo-keyfinder.table-layout.v1", JSON.stringify({
      visible: ["filename", "detectedBpm"],
      order: ["filename", "detectedBpm", "detectedCode"],
      widths: { filename: 260 },
    }));
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    expect(screen.getByRole("columnheader", { name: /^BPM tag/ })).toBeInTheDocument();
    const headers = screen.getAllByRole("columnheader");
    expect(headers.indexOf(screen.getByRole("columnheader", { name: /^BPM tag/ })))
      .toBeLessThan(headers.indexOf(screen.getByRole("columnheader", { name: /^Detected BPM/ })));
  });

  it("reorders columns by dragging a header grip and persists the order", async () => {
    const user = userEvent.setup();
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    const titleGrip = screen.getByRole("button", { name: "Reorder Title column" });
    const albumHeader = screen.getByRole("columnheader", { name: /^Album/ });
    vi.spyOn(albumHeader, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 100, top: 0, bottom: 40, width: 100, height: 40, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.pointerDown(titleGrip, { button: 0, clientX: 10 });
    act(() => {
      fileDropHoverHandler?.(true);
      fileDropHandler?.(["/not-a-real-column-file"]);
    });
    expect(screen.queryByText("Drop files to add")).not.toBeInTheDocument();
    expect(native.expandFiles).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(window, { clientX: 75 });
    fireEvent.pointerUp(window, { clientX: 75 });

    const headers = screen.getAllByRole("columnheader");
    expect(headers.indexOf(screen.getByRole("columnheader", { name: /^Title/ })))
      .toBeGreaterThan(headers.indexOf(screen.getByRole("columnheader", { name: /^Album/ })));
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("neo-keyfinder.table-layout.v1") ?? "null");
      expect(stored.order.indexOf("title")).toBeGreaterThan(stored.order.indexOf("album"));
    });

    await user.click(screen.getByRole("button", { name: "Choose table columns" }));
    await user.click(screen.getByRole("button", { name: "Reset order" }));
    const resetHeaders = screen.getAllByRole("columnheader");
    expect(resetHeaders.indexOf(screen.getByRole("columnheader", { name: /^Title/ })))
      .toBeLessThan(resetHeaders.indexOf(screen.getByRole("columnheader", { name: /^Album/ })));
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("neo-keyfinder.table-layout.v1") ?? "null");
      expect(stored.order.slice(0, 4)).toEqual(["filename", "title", "artist", "album"]);
    });
  });

  it("browses read-only libraries and warns before replacing the batch", async () => {
    const user = userEvent.setup();
    const playlist: Playlist = {
      id: "itunes-set",
      name: "Warmup",
      source: "itunes",
      origin: "/Music/iTunes Library.xml",
      tracks: [track.path],
      readOnly: true,
    };
    vi.mocked(native.discoverLibraries).mockResolvedValue({ playlists: [playlist], warnings: [] });
    vi.mocked(native.loadSettings).mockResolvedValue(playlistSettings);
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track], warnings: [] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Add files" }));
    await screen.findByText(track.filename);
    await user.click(await screen.findByRole("button", { name: /Warmup/ }));

    expect(confirm).toHaveBeenCalledWith("Loading this playlist replaces the current batch. Continue?");
    expect(native.expandFiles).toHaveBeenCalledTimes(1);
  });

  it("toggles the playlist sidebar from the table toolbar", async () => {
    const user = userEvent.setup();
    vi.mocked(native.loadSettings).mockResolvedValue(playlistSettings);
    render(<App />);

    expect(await screen.findByRole("complementary", { name: "Libraries" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide playlists" }));

    expect(screen.queryByRole("complementary", { name: "Libraries" })).not.toBeInTheDocument();
    expect(native.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      presentation: expect.objectContaining({ libraryOpen: false }),
    }));
    const show = screen.getByRole("button", { name: "Show playlists" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    await user.click(show);

    expect(screen.getByRole("complementary", { name: "Libraries" })).toBeInTheDocument();
    expect(native.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      presentation: expect.objectContaining({ libraryOpen: true }),
    }));
  });

  it("opens application actions from the table hamburger menu", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("Engine online");
    await user.click(screen.getByRole("button", { name: "Open application menu" }));
    const menu = screen.getByRole("menu", { name: "Application actions" });
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Check for updates" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "About NeoKeyAndBpmFinder" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "New window" }));

    expect(native.newBatchWindow).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "Application actions" })).not.toBeInTheDocument();
  });

  it("imports a standalone M3U playlist into the read-only browser", async () => {
    const user = userEvent.setup();
    const playlist: Playlist = {
      id: "m3u-set",
      name: "Road Trip",
      source: "m3u",
      origin: "/Music/road-trip.m3u8",
      tracks: [track.path],
      readOnly: true,
    };
    vi.mocked(native.pickPlaylistFile).mockResolvedValue(playlist.origin);
    vi.mocked(native.loadSettings).mockResolvedValue(playlistSettings);
    vi.mocked(native.loadPlaylist).mockResolvedValue({ playlists: [playlist], warnings: [] });
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "+ Import playlist" }));

    expect(native.loadPlaylist).toHaveBeenCalledWith(playlist.origin);
    expect(await screen.findByText(track.filename)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Road Trip/ })).toBeInTheDocument();
  });

  it("checks the latest published release from the About view", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      tag_name: "v0.2.0",
      html_url: "https://github.com/t-MURO/neo-keyfinder/releases/tag/v0.2.0",
    }), { status: 200 }));
    render(<App />);

    await screen.findByText("Engine online");
    await user.click(screen.getByRole("button", { name: "Open application menu" }));
    await user.click(screen.getByRole("menuitem", { name: "About NeoKeyAndBpmFinder" }));
    const dialog = await screen.findByRole("dialog", { name: "About NeoKeyAndBpmFinder" });
    await user.click(within(dialog).getByRole("button", { name: "Check for updates" }));

    expect(await within(dialog).findByText("A newer release is available: v0.2.0")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Open release" })).toBeEnabled();
  });
});
