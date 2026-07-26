import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installVcpkgManifest,
  prepareEssentia,
  resolvePkgConfig,
} from "./build-essentia.mjs";

if (process.platform !== "darwin") {
  throw new Error("The universal sidecar can only be built on macOS.");
}
if (!process.env.VCPKG_ROOT) {
  throw new Error("VCPKG_ROOT is required for a reproducible universal build.");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "native");
const sidecars = [];
const pkgConfig = resolvePkgConfig(process.env.VCPKG_ROOT);

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

for (const architecture of ["arm64", "x64"]) {
  const vcpkgTriplet = `${architecture}-osx`;
  installVcpkgManifest(process.env.VCPKG_ROOT, vcpkgTriplet);
  const essentiaRoot = prepareEssentia({
    architecture,
    eigenInclude: join(root, "vcpkg_installed", vcpkgTriplet, "include", "eigen3"),
  });
  const buildRoot = join(nativeRoot, `build-${architecture}-release`);
  run("cmake", [
    "-S", nativeRoot,
    "-B", buildRoot,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DNKF_BUILD_TESTS=OFF",
    "-UESSENTIA_INCLUDE_DIR",
    "-UESSENTIA_LIBRARY",
    "-UEIGEN3_INCLUDE_DIR",
    `-DESSENTIA_ROOT=${essentiaRoot}`,
    ...(pkgConfig ? [`-DPKG_CONFIG_EXECUTABLE=${pkgConfig}`] : []),
    `-DCMAKE_TOOLCHAIN_FILE=${join(process.env.VCPKG_ROOT, "scripts", "buildsystems", "vcpkg.cmake")}`,
    `-DVCPKG_MANIFEST_DIR=${root}`,
    `-DVCPKG_OVERLAY_PORTS=${join(root, "vcpkg", "ports")}`,
    `-DVCPKG_OVERLAY_TRIPLETS=${join(root, "vcpkg", "triplets")}`,
    `-DVCPKG_TARGET_TRIPLET=${vcpkgTriplet}`,
    `-DCMAKE_OSX_ARCHITECTURES=${architecture === "x64" ? "x86_64" : "arm64"}`,
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0",
  ]);
  run("cmake", ["--build", buildRoot, "--config", "Release", "--target", "keyfinder-native", "--parallel"]);
  sidecars.push({
    architecture,
    path: join(buildRoot, "keyfinder-native"),
  });
}

const binaries = join(root, "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });
for (const sidecar of sidecars) {
  const triple = sidecar.architecture === "arm64"
    ? "aarch64-apple-darwin"
    : "x86_64-apple-darwin";
  const architectureDestination = join(binaries, `keyfinder-native-${triple}`);
  copyFileSync(sidecar.path, architectureDestination);
  chmodSync(architectureDestination, 0o755);
  console.log(`Prepared ${sidecar.architecture} sidecar: ${architectureDestination}`);
}

const destination = join(binaries, "keyfinder-native-universal-apple-darwin");
run("lipo", ["-create", ...sidecars.map((sidecar) => sidecar.path), "-output", destination]);
chmodSync(destination, 0o755);
console.log(`Prepared universal sidecar: ${destination}`);
