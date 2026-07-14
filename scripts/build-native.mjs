import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installVcpkgManifest, prepareEssentia } from "./build-essentia.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "native");
const binariesRoot = join(root, "src-tauri", "binaries");
const release = process.argv.includes("--release");
const configuration = release ? "Release" : "Debug";
const requestedVcpkgRoot = process.env.VCPKG_ROOT;
const vcpkgRoot = requestedVcpkgRoot && existsSync(
  join(requestedVcpkgRoot, "scripts", "buildsystems", "vcpkg.cmake"),
)
  ? requestedVcpkgRoot
  : undefined;
const dependencyVariant = vcpkgRoot
  ? `build-${process.env.VCPKG_TARGET_TRIPLET || "vcpkg"}-${configuration.toLowerCase()}`
  : "build";
const buildRoot = join(nativeRoot, dependencyVariant);
const targetTriple = execFileSync("rustc", ["--print", "host-tuple"], {
  encoding: "utf8",
}).trim();

if (release && !vcpkgRoot && process.env.NKF_ALLOW_SYSTEM_RELEASE_DEPS !== "1") {
  console.error(
    "Release bundles require VCPKG_ROOT so FFmpeg, TagLib, FFTW, and libkeyfinder are linked into the sidecar. See DEVELOPMENT.md. Set NKF_ALLOW_SYSTEM_RELEASE_DEPS=1 only for a non-distributable local diagnostic build.",
  );
  process.exit(1);
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

try {
  run("cmake", ["--version"]);
} catch {
  console.error(
    "CMake 3.24 or newer is required. See DEVELOPMENT.md for platform-specific installation steps.",
  );
  process.exit(1);
}

mkdirSync(buildRoot, { recursive: true });
mkdirSync(binariesRoot, { recursive: true });

if (vcpkgRoot) {
  installVcpkgManifest(vcpkgRoot, process.env.VCPKG_TARGET_TRIPLET);
}
const vcpkgEigen = process.env.VCPKG_TARGET_TRIPLET
  ? join(root, "vcpkg_installed", process.env.VCPKG_TARGET_TRIPLET, "include", "eigen3")
  : undefined;
const architecture = process.env.VCPKG_TARGET_TRIPLET?.split("-")[0] ||
  (targetTriple.startsWith("aarch64") ? "arm64" : targetTriple.startsWith("x86_64") ? "x64" : process.arch);
const essentiaRoot = prepareEssentia({ architecture, eigenInclude: vcpkgEigen });

const configureArguments = [
  "-S",
  nativeRoot,
  "-B",
  buildRoot,
  `-DCMAKE_BUILD_TYPE=${configuration}`,
  "-DNKF_BUILD_TESTS=ON",
  "-UESSENTIA_INCLUDE_DIR",
  "-UESSENTIA_LIBRARY",
  "-UEIGEN3_INCLUDE_DIR",
  `-DESSENTIA_ROOT=${essentiaRoot}`,
];
if (process.platform === "darwin") {
  configureArguments.push("-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0");
}
if (vcpkgRoot) {
  configureArguments.push(
    `-DCMAKE_TOOLCHAIN_FILE=${join(vcpkgRoot, "scripts", "buildsystems", "vcpkg.cmake")}`,
    `-DVCPKG_MANIFEST_DIR=${root}`,
    `-DVCPKG_OVERLAY_PORTS=${join(root, "vcpkg", "ports")}`,
    `-DVCPKG_OVERLAY_TRIPLETS=${join(root, "vcpkg", "triplets")}`,
  );
  if (process.env.VCPKG_TARGET_TRIPLET) {
    configureArguments.push(`-DVCPKG_TARGET_TRIPLET=${process.env.VCPKG_TARGET_TRIPLET}`);
  }
}
run("cmake", configureArguments);
run("cmake", ["--build", buildRoot, "--config", configuration, "--parallel"]);

const extension = process.platform === "win32" ? ".exe" : "";
const sidecarCandidates = [
  join(buildRoot, `keyfinder-native${extension}`),
  join(buildRoot, configuration, `keyfinder-native${extension}`),
];
const cliCandidates = [
  join(buildRoot, `keyfinder${extension}`),
  join(buildRoot, configuration, `keyfinder${extension}`),
];
const source = sidecarCandidates.find(existsSync);
const cliSource = cliCandidates.find(existsSync);

if (!source || !cliSource) {
  throw new Error(`Native engine and CLI were not produced in ${buildRoot}`);
}

const destination = join(
  binariesRoot,
  `keyfinder-native-${targetTriple}${extension}`,
);

copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
console.log(`Prepared sidecar: ${destination}`);

const cliDestination = join(binariesRoot, `keyfinder-${targetTriple}${extension}`);
copyFileSync(cliSource, cliDestination);
if (process.platform !== "win32") chmodSync(cliDestination, 0o755);
console.log(`Prepared CLI: ${cliDestination}`);
