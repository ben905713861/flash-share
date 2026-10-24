import { spawnSync } from "node:child_process";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
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
const skippedAssets = [];
try {
  await access(bundleDir);
  for (const filePath of await collectFiles(bundleDir)) {
    if (hasVersionInName(path.basename(filePath), version)) {
      assets.push({ filePath });
    } else {
      skippedAssets.push({ filePath, reason: `filename does not match version ${version}` });
    }
  }
} catch {
  console.warn(`Tauri bundle directory does not exist: ${bundleDir}`);
}

for (const outputDir of androidOutputDirs) {
  try {
    await access(outputDir);
    for (const filePath of await collectFiles(outputDir)) {
      if (![".apk", ".aab"].includes(path.extname(filePath).toLowerCase())) continue;

      const artifactVersion = await getAndroidArtifactVersion(filePath, outputDir);
      if (artifactVersion !== version) {
        skippedAssets.push({
          filePath,
          reason: artifactVersion
            ? `Android version ${artifactVersion} does not match ${version}`
            : "Android output-metadata.json version was not found",
        });
        continue;
      }

      assets.push({
        filePath,
        uploadName: getAndroidAssetName(filePath),
      });
    }
  } catch {
    // Android builds may produce either APKs, AABs, or both.
  }
}

if (skippedAssets.length > 0) {
  console.log(`Skipping ${skippedAssets.length} artifact(s) that do not match version ${version}:`);
  for (const { filePath, reason } of skippedAssets) {
    console.log(`  ${path.relative(projectDir, filePath)} (${reason})`);
  }
}

if (assets.length === 0) {
  throw new Error(
    `No Tauri or Android build artifacts matching version ${version} found. Build the current version before uploading.`,
  );
}

const msiAsset = assets.find(({ filePath }) => filePath.endsWith(".msi"));
const msiSignature = assets.find(({ filePath }) => filePath.endsWith(".msi.sig"));
if (!msiAsset || !msiSignature) {
  throw new Error("Windows updater metadata requires both an MSI bundle and its signature.");
}

const updaterMetadataPath = path.join(os.tmpdir(), "latest.json");

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

function hasVersionInName(fileName, expectedVersion) {
  const escapedVersion = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[_\\s-])${escapedVersion}(?=$|[_\\s.-])`).test(fileName);
}

async function getAndroidArtifactVersion(filePath, outputDir) {
  const resolvedFilePath = path.resolve(filePath);
  let metadataDir = path.dirname(resolvedFilePath);
  const resolvedOutputDir = path.resolve(outputDir);

  while (metadataDir === resolvedOutputDir || metadataDir.startsWith(`${resolvedOutputDir}${path.sep}`)) {
    try {
      const metadataPath = path.join(metadataDir, "output-metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      const artifact = metadata.elements?.find((element) =>
        typeof element.outputFile === "string" &&
        path.resolve(metadataDir, element.outputFile) === resolvedFilePath,
      );
      if (artifact) return artifact.versionName;
    } catch {
      // Metadata may be absent in a nested output directory; keep looking upward.
    }

    if (metadataDir === resolvedOutputDir) break;
    metadataDir = path.dirname(metadataDir);
  }

  return undefined;
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

const releaseAssetsResult = runGh(["release", "view", tag, "--json", "assets"]);
if (releaseAssetsResult.status !== 0) {
  process.exit(releaseAssetsResult.status ?? 1);
}

const releaseAssets = JSON.parse(releaseAssetsResult.stdout.toString("utf8")).assets;
const uploadedMsi = releaseAssets.find(({ name }) => name === path.basename(msiAsset.filePath));
if (!uploadedMsi?.url) {
  throw new Error(`Could not find the uploaded MSI URL for ${path.basename(msiAsset.filePath)}.`);
}

const updaterMetadata = {
  version,
  notes: "",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: (await readFile(msiSignature.filePath, "utf8")).trim(),
      url: uploadedMsi.url,
    },
  },
};
await writeFile(updaterMetadataPath, `${JSON.stringify(updaterMetadata, null, 2)}\n`);

const updaterJson = runGh(["release", "upload", tag, updaterMetadataPath, "--clobber"], {
  stdio: "inherit",
});
if (updaterJson.status !== 0) {
  process.exit(updaterJson.status ?? 1);
}

console.log(`Uploaded ${assets.length} artifact(s) and latest.json to GitHub release ${tag}.`);
