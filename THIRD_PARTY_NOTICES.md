# Third-party notices

Neo KeyFinder is distributed under GPL-3.0-or-later. It builds on open-source
components whose own copyright notices and license texts remain authoritative:

- libKeyFinder — GPL-3.0
- FFmpeg — LGPL-2.1-or-later/GPL components according to the selected build
- TagLib — LGPL-2.1-or-later/MPL-1.1
- pugixml — MIT
- nlohmann/json — MIT
- Tauri — Apache-2.0/MIT
- React — MIT

Release bundles are built from the exact dependency versions pinned by
`package-lock.json`, `src-tauri/Cargo.lock`, `vcpkg.json`, and
`native/CMakeLists.txt`. Consult those components' bundled or upstream license
files for the complete terms.
