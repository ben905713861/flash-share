import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appPackagePath = path.join(scriptDir, "..", "package.json");
const appConfigPath = path.join(scriptDir, "..", "app.json");
const appPackage = await readFile(appPackagePath, "utf8");
const appConfig = await readFile(appConfigPath, "utf8");
const packageMatch = appPackage.match(/^  "version": "(\d+)\.(\d+)\.(\d+)",$/m);
const appMatch = appConfig.match(/^    "version": "(\d+)\.(\d+)\.(\d+)",$/m);
const versionCodeMatch = appConfig.match(/^      "versionCode": (\d+),$/m);

if (!packageMatch || !appMatch || !versionCodeMatch) {
  throw new Error("Could not read the Expo app versions or Android versionCode.");
}

const current = packageMatch.slice(1).join(".");
if (appMatch.slice(1).join(".") !== current) {
  throw new Error("Expo app versions differ; align package.json and app.json before committing.");
}

const next = `${packageMatch[1]}.${packageMatch[2]}.${Number(packageMatch[3]) + 1}`;
const runtimeVersion = `${packageMatch[1]}.${packageMatch[2]}`;
const currentVersionCode = Number(versionCodeMatch[1]);
const nextVersionCode = currentVersionCode + 1;
if (!Number.isSafeInteger(currentVersionCode) || !Number.isSafeInteger(nextVersionCode)) {
  throw new Error("Android versionCode must be a safe integer.");
}
const nextPackage = appPackage.replace(packageMatch[0], `  "version": "${next}",`);
const appRuntimePattern = /^    "runtimeVersion": "[^"]+",\r?$/m;
const nextAppVersion = appConfig
  .replace(appMatch[0], `    "version": "${next}",`)
  .replace(versionCodeMatch[0], `      "versionCode": ${nextVersionCode},`);
const nextAppConfig = appRuntimePattern.test(appConfig)
  ? nextAppVersion.replace(appRuntimePattern, `    "runtimeVersion": "${runtimeVersion}",`)
  : nextAppVersion.replace(
      `    "version": "${next}",`,
      `    "version": "${next}",\n    "runtimeVersion": "${runtimeVersion}",`,
    );

const updates = [
  [appPackagePath, nextPackage],
  [appConfigPath, nextAppConfig],
];
const tauriConfigPath = path.join(scriptDir, "..", "src-tauri", "tauri.conf.json");
const cargoManifestPath = path.join(scriptDir, "..", "src-tauri", "Cargo.toml");
const cargoLockPath = path.join(scriptDir, "..", "src-tauri", "Cargo.lock");
const tauriConfig = await readFile(tauriConfigPath, "utf8");
const cargoManifest = await readFile(cargoManifestPath, "utf8");
const cargoLock = await readFile(cargoLockPath, "utf8");
const cargoPackage = cargoManifest.match(/^\[package\]\r?\n[^]*?(?=^\[|(?![^]))/m)?.[0];
const cargoName = cargoPackage?.match(/^name = "([^"]+)"\r?$/m)?.[1];

if (!cargoName) {
  throw new Error("Could not read the Tauri Cargo package name.");
}

const cargoLockPackage = cargoLock.split(/(?=^\[\[package\]\])/m).find(
  (section) => section.match(/^name = "([^"]+)"\r?$/m)?.[1] === cargoName,
);

function replaceVersion(content, pattern, label) {
  if (!content || !pattern.test(content)) {
    throw new Error(`Could not read the version in ${label}.`);
  }
  return content.replace(pattern, `$1${next}$2`);
}

updates.push(
  [tauriConfigPath, replaceVersion(tauriConfig, /^(  "version": ")[^"]+("[,]?\r?)$/m, "tauri.conf.json")],
  [cargoManifestPath, cargoManifest.replace(cargoPackage, replaceVersion(cargoPackage, /^(version = ")[^"]+("\r?)$/m, "Cargo.toml"))],
  [cargoLockPath, cargoLock.replace(cargoLockPackage, replaceVersion(cargoLockPackage, /^(version = ")[^"]+("\r?)$/m, "Cargo.lock"))],
);

for (const [filePath, content] of updates) {
  await writeFile(filePath, content);
}

for (const [filePath] of updates) {
  const relativePath = path.relative(path.dirname(scriptDir), filePath);
  const staged = spawnSync(
    "git",
    ["add", "-f", "--", relativePath],
    { cwd: path.dirname(scriptDir), stdio: "inherit" },
  );

  if (staged.status !== 0) {
    process.exit(staged.status ?? 1);
  }
}

console.log(`Expo and Tauri app versions bumped: ${current} -> ${next}`);
