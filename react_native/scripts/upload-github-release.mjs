import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.join(scriptDir, "..");
const tauriConfigPath = path.join(projectDir, "src-tauri", "tauri.conf.json");
const bundleDir = path.join(projectDir, "src-tauri", "target", "release", "bundle");
const androidOutputDirs = [
  path.join(projectDir, "android", "app", "build", "outputs", "apk", "release"),
  path.join(projectDir, "android", "app", "build", "outputs", "bundle", "release"),
];

const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
const requestedTag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;

if (
  (tagIndex >= 0 && (!requestedTag || requestedTag.startsWith("-"))) ||
  (tagIndex >= 0 && (args.length !== 2 || tagIndex !== 0)) ||
  (tagIndex < 0 && args.length > 0)
) {
  throw new Error("Usage: node scripts/upload-github-release.mjs [--tag <release-tag>]");
}

const tauriConfig = JSON.parse(await readFile(tauriConfigPath, "utf8"));
const version = tauriConfig.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid Tauri version in ${tauriConfigPath}.`);
}

const tag = requestedTag ?? `v${version}`;

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

const assets = [];
try {
  await access(bundleDir);
  assets.push(...(await collectFiles(bundleDir)).map((filePath) => ({ filePath })));
} catch {
  console.warn(`Tauri bundle directory does not exist: ${bundleDir}`);
}

for (const outputDir of androidOutputDirs) {
  try {
    await access(outputDir);
    assets.push(
      ...(await collectFiles(outputDir))
        .filter((filePath) => [".apk", ".aab"].includes(path.extname(filePath).toLowerCase()))
        .map((filePath) => ({
          filePath,
          uploadName: getAndroidAssetName(filePath),
        })),
    );
  } catch {
    // Android builds may produce either APKs, AABs, or both.
  }
}

if (assets.length === 0) {
  throw new Error(
    "No Tauri or Android build artifacts found. Run npm run tauri-build or an Android release build first.",
  );
}

function runGh(args, options = {}) {
  const result = spawnSync("gh", args, {
    cwd: projectDir,
    ...options,
  });

  if (result.error?.code === "ENOENT") {
    throw new Error("GitHub CLI (gh) is not installed or is not available on PATH.");
  }
  return result;
}

function getAndroidAssetName(filePath) {
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);
  const variant = baseName
    .replace(/^app/, "")
    .replace(/-release$/, "")
    .replace(/^-/, "");
  const variantSuffix = variant ? `-${variant}` : "";
  return `Flash.Share.android_${version}${variantSuffix}${extension}`;
}

const release = runGh(["release", "view", tag], { stdio: "ignore" });
if (release.status !== 0) {
  console.log(`GitHub release ${tag} was not found; creating it.`);
  const created = runGh(["release", "create", tag, "--title", tag, "--generate-notes"], {
    stdio: "inherit",
  });
  if (created.status !== 0) {
    process.exit(created.status ?? 1);
  }
}

const gh = runGh([
  "release",
  "upload",
  tag,
  ...assets.map(({ filePath, uploadName }) => uploadName ? `${filePath}#${uploadName}` : filePath),
  "--clobber",
], {
  stdio: "inherit",
});
if (gh.status !== 0) {
  process.exit(gh.status ?? 1);
}

console.log(`Uploaded ${assets.length} artifact(s) to GitHub release ${tag}.`);
