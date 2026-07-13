# KeyFinder

KeyFinder is a modern, cross-platform rebuild of the original Qt application.
It is intentionally isolated from the read-only reference checkout in
`../is_KeyFinder/`.

The Phase 1 core workflow is implemented:

- Recursive file/folder intake, drag and drop, canonical deduplication, symlink
  cycle protection, extension filtering, and per-file errors.
- Streaming FFmpeg decode into pinned libkeyfinder 2.2.8, with bounded parallel
  jobs, progress, duration limits, cancellation, and retryable rows.
- TagLib metadata reads and independent field writes for the supplied MP3,
  FLAC, AAC, WMA, WAV, and AIFF corpus. An in-process FFmpeg remux fallback
  covers the supplied ALAC fixture.
- Legacy output rules, notation modes, skip behavior, automatic writes, manual
  writes, and collision-safe filename changes.
- A virtualized, sortable React batch table with multi-selection, copy, remove,
  clear, analysis/write controls, persisted settings, and window sizing.
- A restricted Tauri bridge to one persistent, versioned JSON-Lines sidecar.
  The webview receives no shell or unrestricted filesystem permission.
- One-time compatible legacy QSettings migration on macOS, Windows, and Linux.

Phase 2 playlist/library integrations, multiple windows, the CLI, About/update
flow, and localization infrastructure remain intentionally separate.

## Quick start

Install the platform prerequisites in [DEVELOPMENT.md](DEVELOPMENT.md), then:

```sh
npm install
npm test
npm run dev
```

## Project layout

```text
neo-keyfinder/
├── app/          React and TypeScript desktop interface
├── native/       C++ analysis, metadata, jobs, and protocol
├── scripts/      Sidecar and universal-binary build preparation
├── src-tauri/    Restricted Rust bridge, settings, and Tauri shell
├── vcpkg/        Pinned libkeyfinder 2.2.8 release overlay
└── .github/      Cross-platform test and installer builds
```

## License

The replacement is licensed under GPL-3.0-or-later. Dependency licenses remain
the property of their respective authors and are included by their respective
package managers/bundlers.
