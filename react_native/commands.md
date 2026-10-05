# Android and IOS
## Start local dev mode
1. starts web dev mode  
  `npm run web`

2. starts Android dev mode  
  `npm run android`

## Re-init project
1. delete below folders
  - .expo
  - android
  - modules/*/android/build

2. recreate the above folders  
  `npx expo prebuild`

## Build production release
1. install eas-cli  
  `npm install -g eas-cli`

2. check eas-cli  
  `eas --version`

3. login with Expo account, should register account in https://expo.dev/  
  `eas login`

4. build eas.json and update app.json  
  `eas build:configure`

5. add env variables  
  `eas env:set --environment production`

6. build Android APP  
  `eas build --platform android --profile production`


# windows
## Init tauri project and start dev mode
1. install tauri cli  
  `npm install -D @tauri-apps/cli`

2. init tauri  
  `npx tauri init`  
    ```text
    ✔ What is your app name? · react_native
    ✔ What should the window title be? · react_native
    ✔ Where are your web assets (HTML/CSS/JS) located, relative to the "<current dir>/src-tauri/tauri.conf.json" file that will be created? · ../build
    ✔ What is the url of your dev server? · http://localhost:8081
    ✔ What is your frontend dev command? · npm run web (can remove this)
    ✔ What is your frontend build command? · npx expo export --platform web
    ```

3. add `react_native/metro.config.js`  
    ```javascript
    const { getDefaultConfig } = require('expo/metro-config');
    
    /** @type {import('expo/metro-config').MetroConfig} */
    const config = getDefaultConfig(__dirname);
    
    // Rust creates and removes temporary files in this directory while Tauri runs.
    config.resolver.blockList = [
    ...config.resolver.blockList,
    /[\\/]src-tauri[\\/]target(?:[\\/]|$)/,
    ];
    
    module.exports = config;
    ```

4. start tauri  
  `npm run tauri-web`  
  `npm exec tauri dev`  
