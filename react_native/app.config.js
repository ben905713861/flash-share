module.exports = ({ config }) => {
  const versionParts = (config.version ?? "0.0").split(".");

  return {
    ...config,
    runtimeVersion: versionParts.slice(0, 2).join("."),
  };
};
