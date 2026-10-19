import { spawnSync } from "node:child_process";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: scriptDir,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

if (result.status !== 0) {
  console.log("Skipping Git hook setup outside a Git repository.");
  process.exit(0);
}

const hooksDir = path.join(scriptDir, "..", ".githooks");
await chmod(path.join(hooksDir, "pre-commit"), 0o755);
const config = spawnSync(
  "git",
  ["config", "--local", "core.hooksPath", hooksDir],
  { cwd: scriptDir, stdio: "inherit" },
);

if (config.status !== 0) {
  process.exit(config.status ?? 1);
}

console.log(`Git hooks installed from ${hooksDir}`);
