import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("The universal sidecar can only be built on macOS.");
}
if (!process.env.VCPKG_ROOT) {
  throw new Error("VCPKG_ROOT is required for a reproducible universal build.");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(root, "native");
const products = [];

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

for (const architecture of ["arm64", "x64"]) {
  const buildRoot = join(nativeRoot, `build-${architecture}-release`);
  run("cmake", [
    "-S", nativeRoot,
    "-B", buildRoot,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DNKF_BUILD_TESTS=OFF",
    `-DCMAKE_TOOLCHAIN_FILE=${join(process.env.VCPKG_ROOT, "scripts", "buildsystems", "vcpkg.cmake")}`,
    `-DVCPKG_MANIFEST_DIR=${root}`,
    `-DVCPKG_OVERLAY_PORTS=${join(root, "vcpkg", "ports")}`,
    `-DVCPKG_TARGET_TRIPLET=${architecture}-osx`,
    `-DCMAKE_OSX_ARCHITECTURES=${architecture === "x64" ? "x86_64" : "arm64"}`,
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=10.15",
  ]);
  run("cmake", ["--build", buildRoot, "--config", "Release", "--target", "keyfinder-native", "--parallel"]);
  products.push(join(buildRoot, "keyfinder-native"));
}

const binaries = join(root, "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });
const destination = join(binaries, "keyfinder-native-universal-apple-darwin");
run("lipo", ["-create", ...products, "-output", destination]);
chmodSync(destination, 0o755);
console.log(`Prepared universal sidecar: ${destination}`);
