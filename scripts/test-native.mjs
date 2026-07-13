import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usesVcpkg = process.env.VCPKG_ROOT && existsSync(
  join(process.env.VCPKG_ROOT, "scripts", "buildsystems", "vcpkg.cmake"),
);
const dependencyVariant = usesVcpkg
  ? `build-${process.env.VCPKG_TARGET_TRIPLET || "vcpkg"}-debug`
  : "build";
execFileSync(
  "ctest",
  [
    "--test-dir",
    join(root, "native", dependencyVariant),
    "--output-on-failure",
    "-C",
    "Debug",
  ],
  { cwd: root, stdio: "inherit" },
);
