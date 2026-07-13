import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as native from "./lib/native-engine";
import type { NativeEvent, Settings, Track } from "./lib/types";

vi.mock("./lib/native-engine", () => ({
  getNativeHealth: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  pickAudioFiles: vi.fn(),
  pickAudioFolder: vi.fn(),
  expandFiles: vi.fn(),
  startAnalysis: vi.fn(),
  cancelAnalysis: vi.fn(),
  writeTracks: vi.fn(),
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
  libraryPaths: { itunes: "", traktor: "", serato: "" },
  presentation: { compactRows: false, windowWidth: 1120, windowHeight: 760 },
  legacyMigrationCompleted: true,
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
    vi.mocked(native.pickAudioFolder).mockResolvedValue(null);
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
    await user.click(screen.getByRole("button", { name: "+ Add files" }));

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
    await user.click(screen.getByRole("button", { name: "+ Add files" }));
    await screen.findByText(track.filename);
    await user.click(screen.getByRole("button", { name: "Analyze batch" }));

    const completed = { ...track, detectedKey: 6, detectedCode: "C", status: "completed" as const };
    act(() => {
      eventHandler?.({ version: 1, event: "trackUpdated", jobId: "job-1", sequence: 1, payload: { track: completed } });
      eventHandler?.({ version: 1, event: "jobProgress", jobId: "job-1", sequence: 2, payload: { completed: 1, total: 1, fraction: 1 } });
      eventHandler?.({ version: 1, event: "jobFinished", jobId: "job-1", sequence: 3, payload: { cancelled: false, completed: 1, total: 1 } });
    });

    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("Analysis complete");
    expect(screen.getByText(/Last run · 1 of 1 · 100%/)).toBeInTheDocument();
  });

  it("persists output preferences from the settings panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Engine online");
    await user.click(screen.getByRole("button", { name: "Settings" }));

    const dialog = screen.getByRole("dialog", { name: "Analysis & output" });
    await user.selectOptions(within(dialog).getByLabelText("initialKey output"), "overwrite");
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));

    expect(native.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      outputs: expect.objectContaining({ initialKey: "overwrite" }),
    }));
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
    await user.click(screen.getByRole("button", { name: "+ Add files" }));
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

  it("cancels an active batch and keeps sortable columns keyboard-operable", async () => {
    const user = userEvent.setup();
    const second = { ...track, id: "track-2", path: "/Music/A.wav", filename: "A.wav", title: "Alpha" };
    vi.mocked(native.pickAudioFiles).mockResolvedValue([track.path, second.path]);
    vi.mocked(native.expandFiles).mockResolvedValue({ tracks: [track, second], warnings: [] });
    vi.mocked(native.startAnalysis).mockResolvedValue({ jobId: "job-2" });
    vi.mocked(native.cancelAnalysis).mockResolvedValue({ cancelled: true });
    render(<App />);
    await screen.findByText("Engine online");
    await user.click(screen.getByRole("button", { name: "+ Add files" }));

    const titleHeader = await screen.findByRole("columnheader", { name: /^Title/ });
    await user.click(titleHeader);
    expect(titleHeader).toHaveAttribute("aria-sort", "ascending");

    await user.click(screen.getByRole("button", { name: "Analyze batch" }));
    await user.click(screen.getByRole("button", { name: "Cancel analysis" }));
    expect(native.cancelAnalysis).toHaveBeenCalledWith("job-2");
    expect(screen.getByRole("log")).toHaveTextContent("Cancelling after the current decode step");
  });
});
