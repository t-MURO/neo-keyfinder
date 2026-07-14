# NeoKeyAndBpmFinder

NeoKeyAndBpmFinder is a modern, cross-platform rebuild of the original Qt application.
It is intentionally isolated from the read-only reference checkout in
`../is_KeyFinder/`.

The Phase 1 core workflow and Phase 2 integrations are implemented:

- Recursive file/folder intake, drag and drop, canonical deduplication, symlink
  cycle protection, extension filtering, and per-file errors.
- Streaming FFmpeg decode into pinned libkeyfinder 2.2.8 and Essentia rhythm
  analysis for key and BPM detection, with bounded parallel jobs, progress,
  duration limits, cancellation, and retryable rows.
- TagLib metadata reads and independent field writes for the supplied MP3,
  FLAC, AAC, WMA, WAV, and AIFF corpus. An in-process FFmpeg remux fallback
  covers the supplied ALAC fixture.
- Legacy key output rules, notation modes, skip behavior, automatic writes,
  manual writes, standard dedicated BPM-tag output, and collision-safe filename
  changes. Detected BPM is rounded to the nearest whole value when embedded for
  broad player and DJ-software compatibility.
- A virtualized, sortable React batch table with multi-selection, copy, remove,
  clear, key/BPM columns, analysis/write controls, persisted settings, and
  window sizing.
- A restricted Tauri bridge to one persistent, versioned JSON-Lines sidecar.
  The webview receives no shell or unrestricted filesystem permission.
- One-time compatible legacy QSettings migration on macOS, Windows, and Linux.
- Read-only iTunes XML, Traktor NML, and Serato crate browsing, plus standalone
  M3U/M3U8 and iTunes XML imports with replacement warnings.
- Independent batch windows with platform-native File, Edit, Window, and Help
  menus. Analysis events are routed only to the window that owns each job.
- A bundled native `keyfinder` CLI, an in-app AGPL/dependency About view, a
  GitHub published-release check, and typed translation infrastructure seeded
  with the English catalog.

## Quick start

Install the platform prerequisites in [DEVELOPMENT.md](DEVELOPMENT.md), then:

```sh
npm install
npm test
npm run dev
```

## Command line

The native build also produces `keyfinder` (`keyfinder.exe` on Windows):

```sh
keyfinder -f "/path/to/track.flac"
keyfinder --file "/path/to/track.flac" --write
```

`--write` (or `-w`) prepends the detected key to the comment tag using the
legacy default. Exit code `0` means success, `1` means invalid input or an
analysis failure, and `2` means the key was detected but writing failed.

## Project layout

```text
neo-keyfinder/
├── app/          React and TypeScript desktop interface
├── native/       C++ analysis, playlists, CLI, metadata, jobs, and protocol
├── scripts/      Sidecar and universal-binary build preparation
├── src-tauri/    Restricted Rust bridge, settings, and Tauri shell
├── vcpkg/        Pinned libkeyfinder 2.2.8 release overlay
└── .github/      Cross-platform test and installer builds
```

## License

The replacement is licensed under AGPL-3.0-or-later. Dependency licenses remain
the property of their respective authors and are included by their respective
package managers/bundlers.
