# KeyFinder

This is the modern, cross-platform rebuild of KeyFinder. It is intentionally
isolated from the read-only Qt 5 reference application in `../is_KeyFinder/`.

The current code completes the first implementation milestone only:

- React, TypeScript, and Vite render the desktop interface.
- Tauri exposes one typed `get_native_health` command to the webview.
- A persistent C++ sidecar answers versioned JSON-Lines requests.
- The webview has no shell or unrestricted filesystem capability.
- Native, Rust, frontend, and full IPC-path smoke tests protect the boundary.

Audio decoding, metadata, key detection, playlists, and file mutations are not
implemented yet. They stay out of scope until this foundation is stable.

## Quick start

Install the platform prerequisites in [DEVELOPMENT.md](DEVELOPMENT.md), then:

```sh
npm install
npm test
npm run dev
```

`npm run dev` compiles the C++ engine, copies it to Tauri's target-triple
sidecar location, starts Vite, and launches the desktop application.

## Project layout

```text
neo-keyfinder/
├── app/          React and TypeScript frontend
├── native/       C++ domain and JSON-Lines protocol libraries
├── scripts/      Cross-platform sidecar build preparation
├── src-tauri/    Restricted Rust bridge and Tauri application
└── tests/        Reserved for later end-to-end fixtures
```

## License

The replacement is licensed under GPL-3.0-or-later. Dependency licenses remain
the property of their respective authors.
