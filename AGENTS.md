# Repository Guidelines

## Project Structure & Module Organization

- Root TypeScript services (`ws-server.ts`, `pair-service.ts`, `room-service.ts`, and `message-rate-service.ts`) provide WebSocket signaling and room logic. `webrtc.html` is the browser client, and `signal.md` documents the protocol.
- `cf-ws-server/` contains the Cloudflare Worker in `src/index.ts`, Wrangler configuration, and generated binding types.
- `react_native/` is the Expo Router client: screens in `src/app/`, UI in `src/components/`, shared services in `src/lib/`, native modules in `modules/`, Tauri code in `src-tauri/`, and assets in `assets/`.
- Keep generated output and local credentials out of commits; review `.gitignore` before adding build artifacts.

## Build, Test, and Development Commands

Run commands from the package directory they target:

- Root server: `npm install`, then `npm start` runs `ws-server.ts` through `tsx` on port `8787`. The root server uses the certificates in `cert/`, so clients must use a `wss://` URL.
- Cloudflare Worker: `cd cf-ws-server; npm install; npm run dev` starts Wrangler locally; `npm run deploy` publishes; `npm run cf-typegen` refreshes types after binding changes.
- Expo client: copy `react_native/.env.example` to `react_native/.env.local` and set `EXPO_PUBLIC_WS_URL` to the complete WebSocket base URL (including `/ws`), then run `cd react_native; npm install; npm start`. Use `npm run android`, `npm run ios`, or `npm run web` for a platform target; `npm run lint` runs Expo ESLint. `.env.local` is ignored and must not be committed.
- No automated test runner is configured. Exercise pairing, room join/exit, and WebRTC signaling manually; run `npx tsc --noEmit` in the affected package when practical.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, and TypeScript types for public data and message shapes. Follow existing camelCase for variables/functions, PascalCase for React components and types, and kebab-case for route/component filenames (for example, `pair-device.tsx`). Keep platform-specific implementations suffixed `.native.ts` or `.web.ts`. Run `npm run lint` in `react_native` before submitting UI changes.

## Testing Guidelines

No unit/integration framework or coverage threshold is configured. If adding tests, colocate them with the module or use `__tests__/`, name files `*.test.ts`/`*.test.tsx`, and add the runner script to that package.

## Commit & Pull Request Guidelines

Recent commits use short, lowercase, imperative descriptions (for example, `delete h5`, `alert modal`, `cf worker fix`). Keep commits focused and describe the behavior changed. Pull requests should summarize the affected package(s), list validation commands and manual scenarios, link related issues, and include screenshots or recordings for React Native/UI changes. Call out deployment or configuration changes explicitly.

## Security & Configuration Tips

Do not commit private keys, certificates, tokens, or local `.env` files; `cert/` is environment-sensitive. `EXPO_PUBLIC_WS_URL` is bundled into the client and is configuration, not a secret. Use `ws://` for a plain Wrangler local endpoint and `wss://` for the certificate-backed root server or production. Treat pairing keys, room keys, and WebSocket URLs as untrusted input, and verify changes against both the local server and Cloudflare Worker paths before deployment.
