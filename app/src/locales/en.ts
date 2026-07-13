export const en = {
  "library.title": "Libraries",
  "library.refresh": "Refresh libraries",
  "library.hidePlaylists": "Hide playlists",
  "library.showPlaylists": "Show playlists",
  "library.import": "Import playlist",
  "library.empty": "Configure a library path in Settings, or import an M3U or iTunes XML playlist.",
  "library.readOnly": "External playlists are read-only",
  "library.replaceWarning": "Loading this playlist replaces the current batch. Continue?",
  "window.new": "New batch window",
  "about.title": "About Neo KeyFinder",
  "about.description": "Neo KeyFinder estimates musical keys for harmonic mixing.",
  "about.license": "Licensed under GPL-3.0-or-later.",
  "about.dependencies": "Core dependencies: Tauri, React, libKeyFinder, FFmpeg, TagLib, pugixml, and nlohmann/json.",
  "updates.check": "Check for updates",
  "updates.checking": "Checking published releases…",
  "updates.current": "You are running the current published release.",
  "updates.available": "A newer release is available: {version}",
  "updates.none": "No published release is available yet.",
  "updates.failed": "The release check could not be completed.",
} as const;

export type TranslationKey = keyof typeof en;
