import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  schemaVersion: 1,
  parallel: true,
  maxDurationMinutes: 60,
  skipExisting: false,
  automaticWrites: false,
  extensionFilterEnabled: false,
  extensions: ["mp3", "flac", "wav"],
  outputs: { title: "none", artist: "none", album: "none", comment: "prepend", grouping: "none", initialKey: "none", filename: "none" },
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
  durationMs: 452000,
  detectedKey: null,
  detectedCode: "",
  status: "ready",
  error: null,
};

let eventHandler: ((event: NativeEvent) => void) | undefined;

afterEach(cleanup);

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandler = undefined;
    vi.mocked(native.getNativeHealth).mockResolvedValue({ service: "keyfinder-native", engineVersion: "0.1.0", protocolVersion: 1 });
    vi.mocked(native.loadSettings).mockResolvedValue(settings);
    vi.mocked(native.saveSettings).mockResolvedValue();
    vi.mocked(native.pickAudioFiles).mockResolvedValue([]);
    vi.mocked(native.pickPlaylistFile).mockResolvedValue(null);
    vi.mocked(native.discoverLibraries).mockResolvedValue({ playlists: [], warnings: [] });
    vi.mocked(native.newBatchWindow).mockResolvedValue("batch-1");
    vi.mocked(native.getAppInfo).mockResolvedValue({
      name: "Neo KeyFinder",
      version: "0.1.0",
      projectUrl: "https://github.com/t-MURO/neo-keyfinder",
      releaseApiUrl: "https://github.com/t-MURO/neo-keyfinder/releases/latest",
      releaseMetadataUrl: "https://api.github.com/repos/t-MURO/neo-keyfinder/releases/latest",
    });
    vi.mocked(native.listenMenuActions).mockResolvedValue(() => undefined);
    vi.mocked(native.listenForFileDrops).mockResolvedValue(() => undefined);
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
    expect(screen.getByRole("button", { name: "Choose audio files" })).toBeEnabled();
  });

  it("adds picker results and exposes metadata in the batch table", async () => {
    const user = userEvent.setup();
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track], warnings: [] });
    render(<App />);

    await screen.findByText("Engine online");
    await user.click(screen.getByRole("button", { name: "Choose audio files" }));

    expect(await screen.findByText(track.filename)).toBeInTheDocument();
    expect(screen.getByText(track.title)).toBeInTheDocument();
    expect(screen.getByText(track.artist)).toBeInTheDocument();
    expect(native.expandFiles).toHaveBeenCalledWith([track.path], settings);
  });

  it("starts a job and applies ordered sidecar events to the row", async () => {
    const user = userEvent.setup();
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track], warnings: [] });
    vi.mocked(native.startAnalysis).mockResolvedValue({ jobId: "job-1" });
    render(<App />);
    await screen.findByText("Engine online");
    await user.click(screen.getByRole("button", { name: "Choose audio files" }));
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

    const completed = { ...track, detectedKey: 6, detectedCode: "C", status: "completed" as const };
    act(() => {
      eventHandler?.({ version: 1, event: "trackUpdated", jobId: "job-1", sequence: 2, payload: { track: completed } });
      eventHandler?.({ version: 1, event: "jobProgress", jobId: "job-1", sequence: 3, payload: { completed: 1, total: 1, fraction: 1 } });
      eventHandler?.({ version: 1, event: "jobFinished", jobId: "job-1", sequence: 4, payload: { cancelled: false, completed: 1, total: 1 } });
    });

    expect(screen.getByText("C")).toBeInTheDocument();
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

    await user.click(await screen.findByRole("button", { name: "Choose audio files" }));
    await user.click(await screen.findByRole("columnheader", { name: /^Title/ }));
    await user.click(screen.getByRole("button", { name: "Analyze batch" }));

    expect(native.startAnalysis).toHaveBeenCalledWith([alpha, zulu], settings);
    expect(screen.getByText("Alpha.wav").closest("[role='row']")).toHaveClass("is-queued");
    expect(screen.getByText("Zulu.wav").closest("[role='row']")).toHaveClass("is-queued");
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

    await user.click(await screen.findByRole("button", { name: "Choose audio files" }));

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
    await user.selectOptions(within(dialog).getByLabelText("initialKey output"), "overwrite");
    await user.click(within(dialog).getByRole("button", { name: "DJ Notation + Key" }));
    await user.clear(within(dialog).getByLabelText("Separator"));
    await user.type(within(dialog).getByLabelText("Separator"), " / ");
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));

    expect(native.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      notation: "djCombined",
      delimiter: " / ",
      outputs: expect.objectContaining({ initialKey: "overwrite" }),
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
    await user.click(screen.getByRole("button", { name: "Choose audio files" }));
    await user.click(await screen.findByRole("checkbox", { name: `Select ${track.filename}` }));

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("Halcyon + On + On"));

    await user.click(screen.getByRole("button", { name: "Write selected" }));
    expect(native.writeTracks).toHaveBeenCalledWith([completed], settings);

    await user.click(screen.getByRole("button", { name: "Clear results" }));
    expect(screen.queryByText("C")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("heading", { name: "Build your first batch" })).toBeInTheDocument();
  });

  it("allows an explicitly selected completed track to be analyzed again", async () => {
    const user = userEvent.setup();
    const completed = { ...track, detectedKey: 6, detectedCode: "C", status: "completed" as const };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [completed], warnings: [] });
    vi.mocked(native.startAnalysis).mockResolvedValue({ jobId: "job-repeat" });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Choose audio files" }));
    expect(screen.getByRole("button", { name: "Analyze batch" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: `Select ${track.filename}` }));
    const analyzeSelected = screen.getByRole("button", { name: "Analyze selected (1)" });
    expect(analyzeSelected).toBeEnabled();
    await user.click(analyzeSelected);

    expect(native.startAnalysis).toHaveBeenCalledWith([completed], settings);
  });

  it("navigates rows with arrow keys and selects all with the platform shortcut", async () => {
    const user = userEvent.setup();
    const second = { ...track, id: "track-2", path: "/Music/Second.wav", filename: "Second.wav" };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path, second.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track, second], warnings: [] });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Choose audio files" }));
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

    await user.click(await screen.findByRole("button", { name: "Choose audio files" }));
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

    await user.click(await screen.findByRole("button", { name: "Choose audio files" }));
    const secondRow = (await screen.findByText(second.filename)).closest("[role='row']") as HTMLElement;
    fireEvent.contextMenu(secondRow, { clientX: 120, clientY: 180 });

    const clearMenu = screen.getByRole("menu", { name: "Selected row actions" });
    expect(screen.getByRole("checkbox", { name: `Select ${second.filename}` })).toBeChecked();
    await user.click(within(clearMenu).getByRole("menuitem", { name: "Clear detected keys" }));
    expect(secondRow.querySelector(".key-cell")).toHaveTextContent("—");
    expect(screen.getByText(first.filename).closest("[role='row']")?.querySelector(".key-cell")).toHaveTextContent("C");

    const firstRow = screen.getByText(first.filename).closest("[role='row']") as HTMLElement;
    fireEvent.contextMenu(firstRow, { clientX: 120, clientY: 180 });
    await user.click(screen.getByRole("menuitem", { name: "Remove selected rows" }));

    expect(screen.queryByText(first.filename)).not.toBeInTheDocument();
    expect(screen.getByText(second.filename)).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Choose audio files" }));

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

    await user.click(await screen.findByRole("button", { name: "Choose audio files" }));
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
    expect(within(menu).getByRole("menuitem", { name: "About Neo KeyFinder" })).toBeInTheDocument();
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
    await user.click(screen.getByRole("menuitem", { name: "About Neo KeyFinder" }));
    const dialog = await screen.findByRole("dialog", { name: "About Neo KeyFinder" });
    await user.click(within(dialog).getByRole("button", { name: "Check for updates" }));

    expect(await within(dialog).findByText("A newer release is available: v0.2.0")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Open release" })).toBeEnabled();
  });
});
