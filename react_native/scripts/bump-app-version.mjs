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

if (!packageMatch || !appMatch) {
  throw new Error("Could not read the Expo app versions.");
}

const current = packageMatch.slice(1).join(".");
if (appMatch.slice(1).join(".") !== current) {
  throw new Error("Expo app versions differ; align package.json and app.json before committing.");
}

const next = `${packageMatch[1]}.${packageMatch[2]}.${Number(packageMatch[3]) + 1}`;
const nextPackage = appPackage.replace(packageMatch[0], `  "version": "${next}",`);
const nextAppConfig = appConfig.replace(appMatch[0], `    "version": "${next}",`);

await writeFile(appPackagePath, nextPackage);
await writeFile(appConfigPath, nextAppConfig);

const staged = spawnSync(
  "git",
  [
    "add",
    "--",
    path.relative(path.dirname(scriptDir), appPackagePath),
    path.relative(path.dirname(scriptDir), appConfigPath),
  ],
  { cwd: path.dirname(scriptDir), stdio: "inherit" },
);

if (staged.status !== 0) {
  process.exit(staged.status ?? 1);
}

console.log(`Expo app version bumped: ${current} -> ${next}`);
