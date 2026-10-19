import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cargoPath = path.join(scriptDir, "..", "src-tauri", "Cargo.toml");
const configPath = path.join(scriptDir, "..", "src-tauri", "tauri.conf.json");
const cargo = await readFile(cargoPath, "utf8");
const config = await readFile(configPath, "utf8");
const cargoMatch = cargo.match(/^version = "(\d+)\.(\d+)\.(\d+)"$/m);
const configMatch = config.match(/^  "version": "(\d+)\.(\d+)\.(\d+)",$/m);

if (!cargoMatch || !configMatch) {
  throw new Error("Could not read the Tauri versions from Cargo.toml and tauri.conf.json.");
}

const current = cargoMatch.slice(1).join(".");
if (configMatch.slice(1).join(".") !== current) {
  throw new Error("Tauri versions differ; align Cargo.toml and tauri.conf.json before committing.");
}

const next = `${cargoMatch[1]}.${cargoMatch[2]}.${Number(cargoMatch[3]) + 1}`;
const nextCargo = cargo.replace(cargoMatch[0], `version = "${next}"`);
const nextConfig = config.replace(configMatch[0], `  "version": "${next}",`);

await writeFile(cargoPath, nextCargo);
await writeFile(configPath, nextConfig);

const staged = spawnSync(
  "git",
  [
    "add",
    "--",
    path.relative(path.dirname(scriptDir), cargoPath),
    path.relative(path.dirname(scriptDir), configPath),
  ],
  { cwd: path.dirname(scriptDir), stdio: "inherit" },
);

if (staged.status !== 0) {
  process.exit(staged.status ?? 1);
}

console.log(`Tauri version bumped: ${current} -> ${next}`);
