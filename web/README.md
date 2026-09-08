# Web client and PWA

`npm run build:web` creates `dist-web`. Configure the backend's `WISP_WEB_ROOT` with that directory and its `WISP_PUBLIC_ORIGIN` with the HTTPS Tailscale Serve origin. Serve the UI and `/api/v1` from the same origin. Open that URL, name the device, and enter an administrative single-use pairing code.

The web entrypoint injects a `BackendApi` into the existing React interface. It has no Electron bridge or update methods. Authentication uses HttpOnly, Secure, SameSite cookies; the short-lived CSRF value remains in memory. No token is stored in browser local storage, a build variable, or a service worker.

The service worker caches the build's explicit list of static assets only. It never caches API, health, or authenticated conversation responses. Opening offline can show the sign-in shell, but reading server history and sending require connectivity. Per-server local drafts are optional data and can be cleared on sign-out.

To install, use the browser's Install action on Android/desktop or Safari's Share → Add to Home Screen on iOS. Installation does not keep a server connection alive in the background; returning to the app loads a fresh snapshot.

For development, `npm run dev:web` starts the client on loopback port 5174 and proxies `/api` and `/health` to the backend on loopback port 8787. Set the backend public origin to `http://127.0.0.1:5174`. HTTP loopback is allowed only in this development build; production and native clients require HTTPS.

`npm run test:e2e` builds the server and web client and tests Chromium and WebKit using two isolated browser sessions through a local TLS reverse proxy. The self-signed certificate exception is confined to the test runner; application code preserves normal TLS validation.
