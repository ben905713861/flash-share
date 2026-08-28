`npm install -D @tauri-apps/cli`

`npx tauri init`
```text
✔ What is your app name? · react_native
✔ What should the window title be? · react_native
✔ Where are your web assets (HTML/CSS/JS) located, relative to the "<current dir>/src-tauri/tauri.conf.json" file that will be created? · ../build
✔ What is the url of your dev server? · http://localhost:8081
✔ What is your frontend dev command? · npm run web (can remove this)
✔ What is your frontend build command? · npx expo export --platform web
```

add `react_native/metro.config.js`
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

`npm exec tauri dev`
