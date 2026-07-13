# Development guide

## Prerequisites

All platforms need:

- Node.js 20.19 or newer and npm.
- Rust stable with Cargo.
- CMake 3.24 or newer.
- A C++20 compiler.

The versions committed in `package-lock.json` and `src-tauri/Cargo.lock` are the
reproducible application dependency set. The native JSON dependency is pinned
to the exact commit behind nlohmann/json 3.12.0 in `native/CMakeLists.txt`.

### macOS

Install Xcode Command Line Tools and CMake:

```sh
xcode-select --install
brew install cmake
```

Tauri 2 supports macOS 10.15 and newer. A full Xcode installation is needed
only when later work adds iOS targets; mobile is not part of this project.

### Windows x64

Install:

1. Node.js LTS and Rust using the stable MSVC toolchain.
2. Visual Studio 2022 Build Tools with **Desktop development with C++**.
3. The Evergreen WebView2 Runtime if it is not already present.
4. CMake, available from Visual Studio Installer or `winget install Kitware.CMake`.

Run commands below from a Developer PowerShell or a terminal where CMake and
the MSVC compiler are on `PATH`.

### Linux x64 (Debian or Ubuntu)

Install the Tauri desktop libraries plus the build toolchain:

```sh
sudo apt update
sudo apt install build-essential cmake curl file libappindicator3-dev \
  librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev wget
```

Other distributions need equivalent WebKitGTK 4.1, OpenSSL, app indicator,
SVG, and C/C++ development packages.

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
command sends one correlated JSON line and waits up to five seconds for its
response.

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
npm run build
```

The resulting artifacts are below `src-tauri/target/`. Signing and notarization
are intentionally optional until release credentials are supplied.

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

Current error codes are `INVALID_JSON`, `INVALID_REQUEST`, `INVALID_PARAMS`,
`UNSUPPORTED_VERSION`, `UNKNOWN_METHOD`, and `INTERNAL_ERROR`.
