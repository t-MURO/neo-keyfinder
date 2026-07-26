import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "native");
const sidecarOnly = process.argv.includes("--sidecar-only");

if (process.platform !== "win32") {
  console.error("build:windows must be run on Windows.");
  process.exit(1);
}

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function directories(path) {
  return existsSync(path)
    ? readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    : [];
}

function newestDirectory(path) {
  return directories(path).sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }))[0];
}

function findFile(path, filename) {
  if (!existsSync(path)) return undefined;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const candidate = join(path, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      return candidate;
    }
    if (entry.isDirectory()) {
      const nested = findFile(candidate, filename);
      if (nested) return nested;
    }
  }
  return undefined;
}

const programFiles = process.env.ProgramFiles || "C:\\Program Files";
const vcvars = firstExisting([
  process.env.VSINSTALLDIR && join(
    process.env.VSINSTALLDIR,
    "VC",
    "Auxiliary",
    "Build",
    "vcvars64.bat",
  ),
  ...["Community", "BuildTools", "Professional", "Enterprise"].map((edition) =>
    join(
      programFiles,
      "Microsoft Visual Studio",
      "2022",
      edition,
      "VC",
      "Auxiliary",
      "Build",
      "vcvars64.bat",
    )),
]);

if (!vcvars) {
  console.error(
    "Visual Studio 2022 with Desktop development with C++ is required. See DEVELOPMENT.md.",
  );
  process.exit(1);
}

const initialized = spawnSync(
  "cmd.exe",
  ["/d", "/c", `call "${vcvars}" >nul && set`],
  { cwd: root, encoding: "utf8", windowsVerbatimArguments: true },
);
if (initialized.status !== 0) {
  process.stderr.write(initialized.stderr || "Could not initialize Visual Studio.\n");
  process.exit(initialized.status || 1);
}

const env = {};
for (const line of initialized.stdout.split(/\r?\n/)) {
  const separator = line.indexOf("=");
  if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
}

function setEnvironment(name, value) {
  const existing = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing) delete env[existing];
  env[name] = value;
}

function prependPath(paths) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const current = pathKey ? env[pathKey] : "";
  if (pathKey) delete env[pathKey];
  env.PATH = [...paths.filter(Boolean), current].filter(Boolean).join(";");
}

const localVcpkg = join(nativeRoot, ".dependencies", "vcpkg");
const vcpkgRoot = firstExisting([
  process.env.VCPKG_ROOT && existsSync(join(process.env.VCPKG_ROOT, "vcpkg.exe"))
    ? process.env.VCPKG_ROOT
    : undefined,
  existsSync(join(localVcpkg, "vcpkg.exe")) ? localVcpkg : undefined,
]);
if (!vcpkgRoot) {
  console.error(
    "A bootstrapped vcpkg clone is required. Set VCPKG_ROOT or place it at native/.dependencies/vcpkg. See DEVELOPMENT.md.",
  );
  process.exit(1);
}

const pathEntries = [];
const ninja = findFile(join(vcpkgRoot, "downloads", "tools"), "ninja.exe");
if (ninja) {
  pathEntries.push(dirname(ninja));
  setEnvironment("CMAKE_GENERATOR", "Ninja");
}
const localBin = join(nativeRoot, ".dependencies", "local-bin");
if (existsSync(localBin)) pathEntries.push(localBin);

const portableSdkRoot = join(
  nativeRoot,
  ".dependencies",
  "windows-sdk",
  "microsoft.windows.sdk.cpp",
  "c",
);
const portableSdkLibRoot = join(
  nativeRoot,
  ".dependencies",
  "windows-sdk",
  "microsoft.windows.sdk.cpp.x64",
  "c",
);
const sdkVersion = newestDirectory(join(portableSdkRoot, "Include"));
if (sdkVersion) {
  const sdkBin = join(portableSdkRoot, "bin", sdkVersion, "x64");
  pathEntries.push(sdkBin, join(sdkBin, "ucrt"));
  setEnvironment(
    "INCLUDE",
    ["ucrt", "shared", "um", "winrt", "cppwinrt"]
      .map((folder) => join(portableSdkRoot, "Include", sdkVersion, folder))
      .concat(env.INCLUDE || "")
      .filter(Boolean)
      .join(";"),
  );
  setEnvironment(
    "LIB",
    [
      join(portableSdkLibRoot, "ucrt", "x64"),
      join(portableSdkLibRoot, "um", "x64"),
      env.LIB || "",
    ].filter(Boolean).join(";"),
  );
  setEnvironment("WindowsSdkDir", `${portableSdkRoot}\\`);
  setEnvironment("WindowsSDKVersion", `${sdkVersion}\\`);
  setEnvironment("UniversalCRTSdkDir", `${portableSdkRoot}\\`);
  setEnvironment("UCRTVersion", sdkVersion);
}

const visualStudioRoot = resolve(vcvars, "..", "..", "..", "..");
const redistRoot = join(visualStudioRoot, "VC", "Redist", "MSVC");
const redistVersion = newestDirectory(redistRoot);
if (redistVersion) {
  const debugCrt = join(
    redistRoot,
    redistVersion,
    "debug_nonredist",
    "x64",
    "Microsoft.VC143.DebugCRT",
  );
  if (existsSync(debugCrt)) pathEntries.push(debugCrt);
}

prependPath(pathEntries);
setEnvironment("VCPKG_ROOT", vcpkgRoot);
setEnvironment("VCPKG_TARGET_TRIPLET", "x64-windows-static");
setEnvironment("RUSTUP_TOOLCHAIN", "stable-x86_64-pc-windows-msvc");
setEnvironment("_CL_", "/DNOMINMAX");
setEnvironment("PYTHONUTF8", "1");
setEnvironment("PKG_CONFIG_DONT_DEFINE_PREFIX", "1");

const result = spawnSync(
  "cmd.exe",
  [
    "/d",
    "/c",
    sidecarOnly
      ? "npm run native:build -- --release --sidecar-only"
      : "npm run build -- --bundles nsis",
  ],
  { cwd: root, env, stdio: "inherit", windowsVerbatimArguments: true },
);
if (result.error) console.error(`Could not start the Windows build: ${result.error.message}`);
process.exit(result.status ?? 1);
