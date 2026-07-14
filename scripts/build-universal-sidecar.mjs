import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installVcpkgManifest, prepareEssentia } from "./build-essentia.mjs";

if (process.platform !== "darwin") {
  throw new Error("The universal sidecar can only be built on macOS.");
}
if (!process.env.VCPKG_ROOT) {
  throw new Error("VCPKG_ROOT is required for a reproducible universal build.");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "native");
const sidecars = [];
const clis = [];

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
    `-DESSENTIA_ROOT=${essentiaRoot}`,
    `-DCMAKE_TOOLCHAIN_FILE=${join(process.env.VCPKG_ROOT, "scripts", "buildsystems", "vcpkg.cmake")}`,
    `-DVCPKG_MANIFEST_DIR=${root}`,
    `-DVCPKG_OVERLAY_PORTS=${join(root, "vcpkg", "ports")}`,
    `-DVCPKG_OVERLAY_TRIPLETS=${join(root, "vcpkg", "triplets")}`,
    `-DVCPKG_TARGET_TRIPLET=${vcpkgTriplet}`,
    `-DCMAKE_OSX_ARCHITECTURES=${architecture === "x64" ? "x86_64" : "arm64"}`,
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0",
  ]);
  run("cmake", ["--build", buildRoot, "--config", "Release", "--target", "keyfinder-native", "keyfinder-cli", "--parallel"]);
  sidecars.push(join(buildRoot, "keyfinder-native"));
  clis.push(join(buildRoot, "keyfinder"));
}

const binaries = join(root, "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });
const destination = join(binaries, "keyfinder-native-universal-apple-darwin");
run("lipo", ["-create", ...sidecars, "-output", destination]);
chmodSync(destination, 0o755);
console.log(`Prepared universal sidecar: ${destination}`);

const cliDestination = join(binaries, "keyfinder-universal-apple-darwin");
run("lipo", ["-create", ...clis, "-output", cliDestination]);
chmodSync(cliDestination, 0o755);
console.log(`Prepared universal CLI: ${cliDestination}`);
