const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Rust creates and removes temporary files in this directory while Tauri runs.
config.resolver.blockList = [
  ...config.resolver.blockList,
  /[\\/]src-tauri[\\/]target(?:[\\/]|$)/,
];

module.exports = config;
