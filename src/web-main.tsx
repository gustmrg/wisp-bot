import { APP_METADATA } from "@/config/app-metadata";
import { browserDeviceName, createWebWispApi } from "@/web/web-api";

// The browser app talks to the Wisp server that served it, through the same
// `window.wisp` the desktop app's preload exposes.
Object.defineProperty(window, "wisp", {
  value: Object.freeze(
    createWebWispApi({
      origin: window.location.origin,
      storage: window.localStorage,
      deviceName: browserDeviceName(navigator.userAgent),
      appVersion: APP_METADATA.version,
    }),
  ),
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
}

void import("./main");
