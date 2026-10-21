import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cargoPath = path.join(scriptDir, "..", "src-tauri", "Cargo.toml");
const configPath = path.join(scriptDir, "..", "src-tauri", "tauri.conf.json");
const appPackagePath = path.join(scriptDir, "..", "package.json");
const appConfigPath = path.join(scriptDir, "..", "app.json");
const cargo = await readFile(cargoPath, "utf8");
const config = await readFile(configPath, "utf8");
const appPackage = await readFile(appPackagePath, "utf8");
const appConfig = await readFile(appConfigPath, "utf8");
const cargoMatch = cargo.match(/^version = "(\d+)\.(\d+)\.(\d+)"$/m);
const configMatch = config.match(/^  "version": "(\d+)\.(\d+)\.(\d+)",$/m);
const packageMatch = appPackage.match(/^  "version": "(\d+)\.(\d+)\.(\d+)",$/m);
const appMatch = appConfig.match(/^    "version": "(\d+)\.(\d+)\.(\d+)",$/m);

if (!cargoMatch || !configMatch || !packageMatch || !appMatch) {
  throw new Error("Could not read the Tauri and Expo app versions.");
}

const current = cargoMatch.slice(1).join(".");
if (configMatch.slice(1).join(".") !== current) {
  throw new Error("Tauri versions differ; align Cargo.toml and tauri.conf.json before committing.");
}

const next = `${cargoMatch[1]}.${cargoMatch[2]}.${Number(cargoMatch[3]) + 1}`;
const appCurrent = packageMatch.slice(1).join(".");
if (appMatch.slice(1).join(".") !== appCurrent) {
  throw new Error("Expo app versions differ; align package.json and app.json before committing.");
}

const appNext = `${packageMatch[1]}.${packageMatch[2]}.${Number(packageMatch[3]) + 1}`;
const nextCargo = cargo.replace(cargoMatch[0], `version = "${next}"`);
const nextConfig = config.replace(configMatch[0], `  "version": "${next}",`);
const nextPackage = appPackage.replace(packageMatch[0], `  "version": "${appNext}",`);
const nextAppConfig = appConfig.replace(appMatch[0], `    "version": "${appNext}",`);

await writeFile(cargoPath, nextCargo);
await writeFile(configPath, nextConfig);
await writeFile(appPackagePath, nextPackage);
await writeFile(appConfigPath, nextAppConfig);

const staged = spawnSync(
  "git",
  [
    "add",
    "--",
    path.relative(path.dirname(scriptDir), cargoPath),
    path.relative(path.dirname(scriptDir), configPath),
    path.relative(path.dirname(scriptDir), appPackagePath),
    path.relative(path.dirname(scriptDir), appConfigPath),
  ],
  { cwd: path.dirname(scriptDir), stdio: "inherit" },
);

if (staged.status !== 0) {
  process.exit(staged.status ?? 1);
}

console.log(`Tauri version bumped: ${current} -> ${next}`);
console.log(`Expo app version bumped: ${appCurrent} -> ${appNext}`);
