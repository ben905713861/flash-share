const fs = require('fs');
const path = require('path');

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const sourceRoot = path.resolve(__dirname, 'src');

function isSourceFile(filePath) {
  const relativePath = path.relative(sourceRoot, filePath);
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolution = context.resolveRequest(context, moduleName, platform);

  if (
      platform !== 'web' ||
      process.env.APP_WEB_VARIANT !== 'tauri' ||
      resolution.type !== 'sourceFile' ||
      !isSourceFile(resolution.filePath)
  ) {
    return resolution;
  }

  const extension = path.extname(resolution.filePath);
  const basename = resolution.filePath.slice(0, -extension.length);
  const tauriFilePath = basename.endsWith('.web')
      ? `${basename.slice(0, -'.web'.length)}.tauri${extension}`
      : `${basename}.tauri${extension}`;

  return fs.existsSync(tauriFilePath)
      ? { ...resolution, filePath: tauriFilePath }
      : resolution;
};

// Rust creates and removes temporary files in this directory while Tauri runs.
config.resolver.blockList = [
  ...config.resolver.blockList,
  /[\\/]src-tauri[\\/]target(?:[\\/]|$)/,
];

module.exports = config;
