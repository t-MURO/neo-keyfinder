# Development guide

## Prerequisites

All platforms need:

- Node.js 20.19 or newer and npm.
- Rust stable with Cargo.
- CMake 3.24 or newer.
- A C++20 compiler.
- FFmpeg development libraries, TagLib 2, libkeyfinder 2.2.8, and FFTW for
  ordinary local development, or vcpkg for pinned distributable builds.

The versions committed in `package-lock.json` and `src-tauri/Cargo.lock` are the
reproducible application dependency set. The native JSON dependency is pinned
to the exact commit behind nlohmann/json 3.12.0 in `native/CMakeLists.txt`.

### macOS

Install Xcode Command Line Tools and CMake:

```sh
xcode-select --install
brew install cmake ffmpeg taglib libkeyfinder fftw
```

Tauri 2 supports macOS 10.15 and newer. A full Xcode installation is needed
only when later work adds iOS targets; mobile is not part of this project.

### Windows x64

Install:

1. Node.js LTS and Rust using the stable MSVC toolchain.
2. Visual Studio 2022 Build Tools with **Desktop development with C++**.
3. The Evergreen WebView2 Runtime if it is not already present.
4. CMake, available from Visual Studio Installer or `winget install Kitware.CMake`.
5. A local clone of Microsoft vcpkg. Windows native dependencies are built
   statically; no FFmpeg, TagLib, FFTW, or libkeyfinder installation is required
   on the machine that runs the resulting application.

Run commands below from a Developer PowerShell or a terminal where CMake and
the MSVC compiler are on `PATH`.

### Linux x64 (Debian or Ubuntu)

Install the Tauri desktop libraries plus the build toolchain:

```sh
sudo apt update
sudo apt install build-essential cmake curl file libappindicator3-dev \
  librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev wget pkg-config
```

Use the pinned vcpkg setup described under local builds for the native audio
libraries; distro libkeyfinder packages are often older than the required
2.2.8. Other distributions need equivalent WebKitGTK 4.1, OpenSSL, app
indicator, SVG, and C/C++ development packages.

## Set up the project

From `neo-keyfinder/`:

```sh
npm install
```

This installs the root Tauri CLI and the `app/` workspace dependencies.

## Run the desktop app

```sh
npm run dev
```

The native build script performs four deterministic steps:

1. Configures `native/build/` with CMake.
2. Builds `keyfinder-native` and its unit tests.
3. Reads the current Rust target triple.
4. Copies the executable to
   `src-tauri/binaries/keyfinder-native-<target-triple>` for Tauri.

The Rust backend starts that process once and keeps it alive. Each typed Tauri
command sends one correlated JSON line. The continuous reader routes direct
responses by request ID while forwarding ordered analysis events to the
frontend.

## Tests and checks

Run everything:

```sh
npm test
```

Or run one layer:

```sh
npm run frontend:test
npm run frontend:build
npm run native:test
npm run rust:check
npm run rust:test
```

`rust:test` includes the boundary smoke test. It creates a mock frontend
webview, sends the real `get_native_health` IPC request through Tauri, crosses
the production Rust protocol bridge, talks to the compiled C++ process, and
deserializes the result back into the frontend contract.

## Local builds

Build the application binary without creating an installer:

```sh
npm run build:debug
```

Build the platform installer or bundle:

```sh
export VCPKG_ROOT=/absolute/path/to/vcpkg
npm run build
```

Release builds deliberately require `VCPKG_ROOT`. The pinned manifest builds
FFmpeg 8.1.2, TagLib 2.3, FFTW 3.3.11, and the libkeyfinder 2.2.8 overlay as
static sidecar dependencies. On Windows, use `VCPKG_TARGET_TRIPLET=x64-windows-static`;
the NSIS installer contains the Tauri application and its native sidecar and
does not require Python, FFmpeg, TagLib, libkeyfinder, CMake, or vcpkg on the
user's computer. Windows itself supplies WebView2 on current supported releases,
and the installer can bootstrap it where needed.

Build the universal macOS DMG with:

```sh
export VCPKG_ROOT=/absolute/path/to/vcpkg
npm run build:macos-universal -- --bundles dmg
```

The resulting artifacts are below `src-tauri/target/`. CI produces a universal
macOS DMG, a Windows x64 NSIS installer, and Linux x64 AppImage and DEB files.

Signing is optional. The macOS job is ready for Tauri's standard
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` secrets. A Windows
Authenticode `signCommand` can be supplied in a release-only Tauri config when
a certificate service is selected; unsigned CI artifacts remain buildable.

## JSON-Lines protocol v1

Every message occupies exactly one UTF-8 line. A health request is:

```json
{"version":1,"requestId":"health-1","method":"health","params":{}}
```

Success responses contain `result` and never `error`:

```json
{"version":1,"requestId":"health-1","result":{"service":"keyfinder-native","engineVersion":"0.1.0","protocolVersion":1}}
```

Error responses contain `error` and never `result`:

```json
{"version":1,"requestId":"health-1","error":{"code":"UNKNOWN_METHOD","message":"Unknown protocol method: example"}}
```

Protocol operations are `health`, `expandFiles`, `startAnalysis`, `cancelJob`,
and `writeTracks`. Jobs emit ordered `trackUpdated`, `trackProgress`,
`jobProgress`, and `jobFinished` events. Protocol-level error codes include
`INVALID_JSON`, `INVALID_REQUEST`, `INVALID_PARAMS`, `UNSUPPORTED_VERSION`,
`UNKNOWN_METHOD`, and `INTERNAL_ERROR`; track-level errors carry a code, stage,
and user-facing message without terminating unrelated work.
