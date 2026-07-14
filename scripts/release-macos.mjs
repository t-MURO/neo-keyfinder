import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productName = "NeoKeyAndBpmFinder";
const minimumMacosVersion = "11.0";
const targetTriplet = "arm64-osx";
const expectedExecutables = ["keyfinder", "keyfinder-native", "neo-keyfinder"];
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function usage() {
  console.log(`Create and verify an Apple Silicon macOS release.

Usage:
  npm run release:macos
  npm run release:macos -- --version 0.2.0

Options:
  --version <version>  Synchronize all project versions before building
  --allow-dirty       Allow a release from a working tree with local changes
  --check             Check versions and prerequisites without building
  --help              Show this help

VCPKG_ROOT is optional when vcpkg is installed at one of the standard project
locations checked by this script.`);
}

function parseArguments(args) {
  const options = { allowDirty: false, check: false, version: undefined };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--allow-dirty") {
      options.allowDirty = true;
    } else if (argument === "--check") {
      options.check = true;
    } else if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    } else if (argument === "--version") {
      options.version = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--version=")) {
      options.version = argument.slice("--version=".length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.version && !versionPattern.test(options.version)) {
    throw new Error(`Invalid version "${options.version}". Use a semantic version such as 0.2.0.`);
  }
  if (options.check && options.version) {
    throw new Error("--check cannot be combined with --version because check mode never edits files.");
  }
  if (args.includes("--version") && !options.version) {
    throw new Error("--version requires a value, for example --version 0.2.0.");
  }

  return options;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: options.encoding,
    stdio: options.stdio || (options.encoding ? ["ignore", "pipe", "pipe"] : "inherit"),
  });
}

function output(command, args, options = {}) {
  return run(command, args, { ...options, encoding: "utf8" }).trim();
}

function runLogged(command, args, logPath, env) {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "w");
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: root,
      env,
      stdio: ["inherit", log, log],
    });
  } finally {
    closeSync(log);
  }

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
    const tail = lines.slice(-60).join("\n");
    throw new Error(`Build command failed. The last log lines are:\n\n${tail}\n\nFull log: ${logPath}`);
  }
}

function commandExists(command, env) {
  return spawnSync("/usr/bin/which", [command], { env, stdio: "ignore" }).status === 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceVersion(path, pattern, version) {
  const contents = readFileSync(path, "utf8");
  const updated = contents.replace(pattern, `$1${version}$2`);
  if (updated === contents && !contents.includes(`version = "${version}"`)) {
    throw new Error(`Could not update the version in ${path}`);
  }
  writeFileSync(path, updated);
}

function currentVersions() {
  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const cargoVersion = cargoToml.match(/\[package\][\s\S]*?\nversion = "([^"]+)"/)?.[1];
  const cargoLock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
  const cargoLockVersion = cargoLock.match(/\[\[package\]\]\nname = "neo-keyfinder"\nversion = "([^"]+)"/)?.[1];
  const packageLock = readJson(join(root, "package-lock.json"));
  return {
    "package.json": readJson(join(root, "package.json")).version,
    "package-lock.json": packageLock.version,
    "package-lock.json (root package)": packageLock.packages?.[""]?.version,
    "app/package.json": readJson(join(root, "app", "package.json")).version,
    "package-lock.json (app package)": packageLock.packages?.app?.version,
    "src-tauri/Cargo.toml": cargoVersion,
    "src-tauri/Cargo.lock": cargoLockVersion,
    "src-tauri/tauri.conf.json": readJson(join(root, "src-tauri", "tauri.conf.json")).version,
  };
}

function requireSynchronizedVersion() {
  const versions = currentVersions();
  const uniqueVersions = new Set(Object.values(versions));
  if (uniqueVersions.size !== 1 || uniqueVersions.has(undefined)) {
    const details = Object.entries(versions).map(([file, version]) => `  ${file}: ${version || "missing"}`).join("\n");
    throw new Error(`Project versions are not synchronized:\n${details}\nRun with --version <version> to fix them.`);
  }
  const [version] = uniqueVersions;
  if (!versionPattern.test(version)) {
    throw new Error(`The current project version "${version}" is not a supported semantic version.`);
  }
  return version;
}

function synchronizeVersion(version, snapshots) {
  const files = [
    join(root, "package.json"),
    join(root, "package-lock.json"),
    join(root, "app", "package.json"),
    join(root, "src-tauri", "Cargo.toml"),
    join(root, "src-tauri", "Cargo.lock"),
    join(root, "src-tauri", "tauri.conf.json"),
  ];
  for (const path of files) snapshots.set(path, readFileSync(path));

  const rootPackage = readJson(files[0]);
  rootPackage.version = version;
  writeJson(files[0], rootPackage);

  const packageLock = readJson(files[1]);
  packageLock.version = version;
  packageLock.packages[""].version = version;
  packageLock.packages.app.version = version;
  writeJson(files[1], packageLock);

  const appPackage = readJson(files[2]);
  appPackage.version = version;
  writeJson(files[2], appPackage);

  replaceVersion(files[3], /(\[package\][\s\S]*?\nversion = ")[^"]+("\n)/, version);
  replaceVersion(files[4], /(\[\[package\]\]\nname = "neo-keyfinder"\nversion = ")[^"]+("\n)/, version);

  const tauriConfig = readJson(files[5]);
  tauriConfig.version = version;
  writeJson(files[5], tauriConfig);

  const synchronized = requireSynchronizedVersion();
  if (synchronized !== version) throw new Error(`Version synchronization produced ${synchronized}, expected ${version}.`);
}

function restoreSnapshots(snapshots) {
  for (const [path, contents] of snapshots) writeFileSync(path, contents);
}

function ensureCleanWorkingTree(allowDirty) {
  if (allowDirty) return;
  const status = output("git", ["status", "--porcelain", "--untracked-files=normal"]);
  if (status) {
    throw new Error("The working tree is not clean. Commit the changes first or use --allow-dirty intentionally.");
  }
}

function resolveVcpkgRoot() {
  const configuredRoot = process.env.VCPKG_ROOT ? resolve(process.env.VCPKG_ROOT) : undefined;
  const candidates = [
    configuredRoot,
    join(root, ".vcpkg"),
    join(homedir(), ".local", "share", "vcpkg-neo-keyfinder"),
    join(homedir(), "vcpkg"),
  ].filter(Boolean);
  const found = candidates.find((candidate) =>
    existsSync(join(candidate, "vcpkg")) &&
    existsSync(join(candidate, "scripts", "buildsystems", "vcpkg.cmake"))
  );

  if (!found) {
    throw new Error(
      "A bootstrapped vcpkg installation was not found. Set VCPKG_ROOT or install it at ~/.local/share/vcpkg-neo-keyfinder.",
    );
  }
  if (configuredRoot && found !== configuredRoot) {
    throw new Error(`VCPKG_ROOT points to an incomplete installation: ${configuredRoot}`);
  }
  return found;
}

function releaseEnvironment(vcpkgRoot) {
  const cargoBin = join(homedir(), ".cargo", "bin");
  return {
    ...process.env,
    PATH: existsSync(cargoBin) ? `${cargoBin}:${process.env.PATH}` : process.env.PATH,
    MACOSX_DEPLOYMENT_TARGET: minimumMacosVersion,
    VCPKG_ROOT: vcpkgRoot,
    VCPKG_TARGET_TRIPLET: targetTriplet,
  };
}

function checkPrerequisites(env) {
  if (process.platform !== "darwin") throw new Error("The macOS release must be built on macOS.");
  if (output("uname", ["-m"]) !== "arm64") {
    throw new Error("The Apple Silicon release must be built on an arm64 Mac outside Rosetta.");
  }

  const commands = ["cargo", "cmake", "codesign", "git", "hdiutil", "lipo", "npm", "otool", "plutil", "rustc", "vtool"];
  const missing = commands.filter((command) => !commandExists(command, env));
  if (missing.length) throw new Error(`Missing required commands: ${missing.join(", ")}`);

  const rustHost = output("rustc", ["--print", "host-tuple"], { env });
  if (rustHost !== "aarch64-apple-darwin") {
    throw new Error(`The active Rust host is ${rustHost}; expected aarch64-apple-darwin.`);
  }
  if (!existsSync(join(root, "vcpkg", "triplets", "arm64-osx.cmake"))) {
    throw new Error("The project arm64-osx vcpkg triplet is missing.");
  }
}

function ensureNodeDependencies(env) {
  if (existsSync(join(root, "node_modules", ".bin", "tauri"))) return;
  console.log("\nInstalling Node.js dependencies...");
  run("npm", ["ci"], { env });
}

function parseDynamicDependencies(binary) {
  return output("otool", ["-L", binary])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (")[0])
    .filter(Boolean);
}

function verifyDmg(dmgPath, version, env) {
  console.log("\nVerifying disk image and application bundle...");
  run("hdiutil", ["verify", dmgPath], { env, stdio: "ignore" });

  const temporaryRoot = mkdtempSync(join(tmpdir(), "neo-keyfinder-release-"));
  const mountPoint = join(temporaryRoot, "volume");
  mkdirSync(mountPoint);
  let mounted = false;

  try {
    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath], {
      env,
      stdio: "ignore",
    });
    mounted = true;

    const appName = readdirSync(mountPoint).find((entry) => entry.endsWith(".app"));
    if (!appName) throw new Error("The DMG does not contain an application bundle.");
    const appPath = join(mountPoint, appName);
    const infoPlist = join(appPath, "Contents", "Info.plist");
    const bundledVersion = output("plutil", ["-extract", "CFBundleShortVersionString", "raw", infoPlist], { env });
    const bundledMinimum = output("plutil", ["-extract", "LSMinimumSystemVersion", "raw", infoPlist], { env });
    if (bundledVersion !== version) throw new Error(`The bundle version is ${bundledVersion}, expected ${version}.`);
    if (bundledMinimum !== minimumMacosVersion) {
      throw new Error(`The bundle requires macOS ${bundledMinimum}, expected ${minimumMacosVersion}.`);
    }

    const macosDirectory = join(appPath, "Contents", "MacOS");
    const executables = readdirSync(macosDirectory).sort();
    for (const expected of expectedExecutables) {
      if (!executables.includes(expected)) throw new Error(`The application bundle is missing ${expected}.`);
    }

    for (const executable of expectedExecutables) {
      const binary = join(macosDirectory, executable);
      const architectures = output("lipo", ["-archs", binary], { env });
      if (architectures !== "arm64") throw new Error(`${executable} contains ${architectures}, expected only arm64.`);

      const buildInfo = output("vtool", ["-show-build", binary], { env });
      const minimum = buildInfo.match(/\bminos\s+(\S+)/)?.[1];
      if (minimum !== minimumMacosVersion) {
        throw new Error(`${executable} targets macOS ${minimum || "unknown"}, expected ${minimumMacosVersion}.`);
      }

      const unexpectedDependencies = parseDynamicDependencies(binary).filter((dependency) =>
        !dependency.startsWith("/System/Library/") && !dependency.startsWith("/usr/lib/")
      );
      if (unexpectedDependencies.length) {
        throw new Error(`${executable} has non-system dynamic dependencies:\n${unexpectedDependencies.join("\n")}`);
      }
    }

    const signing = spawnSync("codesign", ["--verify", "--deep", "--strict", appPath], {
      env,
      encoding: "utf8",
    });
    const signed = signing.status === 0;
    if (env.APPLE_SIGNING_IDENTITY && !signed) {
      throw new Error(`Code-signing verification failed:\n${signing.stderr.trim()}`);
    }
    return { signed };
  } finally {
    if (mounted) spawnSync("hdiutil", ["detach", mountPoint], { stdio: "ignore" });
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function publishArtifact(sourceDmg, version, verification, buildLogPath) {
  const releaseDirectory = join(root, "release-artifacts", `v${version}`);
  mkdirSync(releaseDirectory, { recursive: true });
  const filename = basename(sourceDmg);
  const destination = join(releaseDirectory, filename);
  const temporaryDestination = `${destination}.tmp-${process.pid}`;
  copyFileSync(sourceDmg, temporaryDestination);
  renameSync(temporaryDestination, destination);

  const checksum = sha256(destination);
  const checksumPath = `${destination}.sha256`;
  const temporaryChecksum = `${checksumPath}.tmp-${process.pid}`;
  writeFileSync(temporaryChecksum, `${checksum}  ${filename}\n`);
  renameSync(temporaryChecksum, checksumPath);

  const manifestPath = join(releaseDirectory, "release.json");
  writeJson(manifestPath, {
    product: productName,
    version,
    platform: "macOS",
    architecture: "arm64",
    minimumSystemVersion: minimumMacosVersion,
    signed: verification.signed,
    artifact: filename,
    buildLog: basename(buildLogPath),
    bytes: statSync(destination).size,
    sha256: checksum,
    createdAt: new Date().toISOString(),
  });

  return { checksum, checksumPath, destination, manifestPath };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  ensureCleanWorkingTree(options.allowDirty);

  const snapshots = new Map();
  let versionChanged = false;
  try {
    if (options.version) {
      versionChanged = true;
      synchronizeVersion(options.version, snapshots);
    }
    const version = requireSynchronizedVersion();
    const vcpkgRoot = resolveVcpkgRoot();
    const env = releaseEnvironment(vcpkgRoot);
    checkPrerequisites(env);

    console.log(`Release check passed: ${productName} ${version}, Apple Silicon, macOS ${minimumMacosVersion}+`);
    console.log(`vcpkg: ${vcpkgRoot}`);
    if (options.check) return;

    ensureNodeDependencies(env);
    console.log("\nBuilding native engine and macOS DMG...");
    const buildLogPath = join(root, "release-artifacts", `v${version}`, "build.log");
    runLogged("npm", ["run", "build", "--", "--bundles", "dmg"], buildLogPath, env);

    const dmgPath = join(
      root,
      "src-tauri",
      "target",
      "release",
      "bundle",
      "dmg",
      `${productName}_${version}_aarch64.dmg`,
    );
    if (!existsSync(dmgPath)) throw new Error(`Tauri did not produce the expected DMG: ${dmgPath}`);

    const verification = verifyDmg(dmgPath, version, env);
    const artifact = publishArtifact(dmgPath, version, verification, buildLogPath);

    console.log("\nRelease complete");
    console.log(`DMG:      ${artifact.destination}`);
    console.log(`SHA-256:  ${artifact.checksum}`);
    console.log(`Manifest: ${artifact.manifestPath}`);
    console.log(`Build log: ${buildLogPath}`);
    if (!verification.signed) {
      console.log("Signing:   unsigned (configure an Apple Developer identity for public distribution)");
    } else {
      console.log("Signing:   verified");
    }
  } catch (error) {
    if (versionChanged) {
      restoreSnapshots(snapshots);
      console.error("\nThe release failed; version files were restored.");
    }
    throw error;
  }
}

try {
  main();
} catch (error) {
  console.error(`\nRelease failed: ${error.message}`);
  process.exit(1);
}
