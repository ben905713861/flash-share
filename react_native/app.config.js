const channelByBuildProfile = {
  development: "development",
  preview: "preview",
  production: "production",
};

module.exports = ({ config }) => ({
  ...config,
  updates: {
    ...config.updates,
    requestHeaders: {
      ...config.updates?.requestHeaders,
      "expo-channel-name":
        process.env.EXPO_UPDATES_CHANNEL ??
        channelByBuildProfile[process.env.EAS_BUILD_PROFILE] ??
        "production",
    },
  },
});
