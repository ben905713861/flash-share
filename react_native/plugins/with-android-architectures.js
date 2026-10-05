const { withGradleProperties } = require('@expo/config-plugins');

const ANDROID_ARCHITECTURES = 'arm64-v8a,x86,x86_64';

module.exports = function withAndroidArchitectures(config) {
  return withGradleProperties(config, (configMod) => {
    const property = configMod.modResults.find(
      (item) =>
        item.type === 'property' &&
        item.key === 'reactNativeArchitectures'
    );

    if (property) {
      property.value = ANDROID_ARCHITECTURES;
    } else {
      configMod.modResults.push({
        type: 'property',
        key: 'reactNativeArchitectures',
        value: ANDROID_ARCHITECTURES,
      });
    }

    return configMod;
  });
};
