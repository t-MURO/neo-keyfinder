import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependenciesRoot = join(root, "native", ".dependencies");
const ESSENTIA_COMMIT = "b9fa6cb674ca43dfb94d28d293aeda441c6745db";
const EIGEN_COMMIT = "3147391d946bb4b6c68edd901f2add6ac1f31f8c";

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: "inherit",
  });
}

function clonePinned(repository, commit, destination) {
  if (!existsSync(join(destination, ".git"))) {
    mkdirSync(dirname(destination), { recursive: true });
    run("git", ["clone", "--filter=blob:none", "--no-checkout", repository, destination]);
  }
  run("git", ["fetch", "origin", commit], { cwd: destination });
  run("git", ["checkout", "--detach", commit], { cwd: destination });
}

function findFile(directory, filename) {
  if (!existsSync(directory)) return undefined;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
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

function pythonCommand() {
  for (const candidate of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next common executable name.
    }
  }
  throw new Error("Python 3 is required to build the pinned Essentia library.");
}

export function installVcpkgManifest(vcpkgRoot, triplet) {
  const executable = join(vcpkgRoot, process.platform === "win32" ? "vcpkg.exe" : "vcpkg");
  const args = [
    "install",
    `--x-manifest-root=${root}`,
    `--overlay-ports=${join(root, "vcpkg", "ports")}`,
    `--overlay-triplets=${join(root, "vcpkg", "triplets")}`,
  ];
  if (triplet) args.push(`--triplet=${triplet}`);
  run(executable, args);
}

export function prepareEssentia({ architecture = process.arch, eigenInclude } = {}) {
  if (process.env.ESSENTIA_ROOT) return resolve(process.env.ESSENTIA_ROOT);

  const cacheKey = `${process.platform}-${architecture}-${ESSENTIA_COMMIT.slice(0, 10)}`;
  const cacheRoot = join(dependenciesRoot, cacheKey);
  const sourceRoot = join(cacheRoot, "source");
  const installRoot = join(cacheRoot, "install");
  const libraryName = process.platform === "win32" ? "essentia.lib" : "libessentia.a";
  if (existsSync(join(installRoot, "lib", libraryName))) return installRoot;

  clonePinned("https://github.com/MTG/essentia.git", ESSENTIA_COMMIT, sourceRoot);

  let resolvedEigen = eigenInclude;
  if (!resolvedEigen || !existsSync(join(resolvedEigen, "Eigen", "Core"))) {
    const eigenRoot = join(dependenciesRoot, `eigen-${EIGEN_COMMIT.slice(0, 10)}`);
    clonePinned("https://gitlab.com/libeigen/eigen.git", EIGEN_COMMIT, eigenRoot);
    resolvedEigen = eigenRoot;
  }
  mkdirSync(join(installRoot, "include"), { recursive: true });
  cpSync(join(resolvedEigen, "Eigen"), join(installRoot, "include", "Eigen"), {
    recursive: true,
  });
  cpSync(
    join(resolvedEigen, "unsupported"),
    join(installRoot, "include", "unsupported"),
    { recursive: true },
  );

  const pkgConfigRoot = join(cacheRoot, "pkgconfig");
  mkdirSync(pkgConfigRoot, { recursive: true });
  writeFileSync(
    join(pkgConfigRoot, "eigen3.pc"),
    `prefix=${resolvedEigen.replaceAll("\\", "/")}\nincludedir=\${prefix}\n\nName: Eigen3\nDescription: C++ template library for linear algebra\nVersion: 3.4.0\nCflags: -I\${includedir}\n`,
  );

  const env = { ...process.env };
  if (process.platform === "darwin" && architecture) {
    const clangArchitecture = architecture === "x64" ? "x86_64" : architecture;
    const flags = `-arch ${clangArchitecture} -mmacosx-version-min=10.15`;
    env.CFLAGS = [env.CFLAGS, flags].filter(Boolean).join(" ");
    env.CXXFLAGS = [env.CXXFLAGS, flags].filter(Boolean).join(" ");
    env.LINKFLAGS = [env.LINKFLAGS, flags].filter(Boolean).join(" ");
  }

  if (process.platform === "win32" && process.env.VCPKG_ROOT) {
    const pkgconfRoot = join(process.env.VCPKG_ROOT, "downloads", "tools", "pkgconf");
    const pkgconf = findFile(pkgconfRoot, "pkgconf.exe");
    if (pkgconf) {
      const toolsRoot = join(cacheRoot, "tools");
      mkdirSync(toolsRoot, { recursive: true });
      copyFileSync(pkgconf, join(toolsRoot, "pkg-config.exe"));
      env.PATH = `${toolsRoot}${delimiter}${env.PATH}`;
    }
  }

  const python = pythonCommand();
  run(python, [
    "waf",
    "configure",
    `--prefix=${installRoot}`,
    "--build-static",
    "--lightweight=",
    "--fft=KISS",
    `--pkg-config-path=${pkgConfigRoot}`,
  ], { cwd: sourceRoot, env });
  run(python, ["waf", `-j${process.env.CMAKE_BUILD_PARALLEL_LEVEL || "4"}`], {
    cwd: sourceRoot,
    env,
  });
  run(python, ["waf", "install"], { cwd: sourceRoot, env });
  return installRoot;
}
