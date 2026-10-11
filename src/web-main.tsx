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

// Without the app, the page would stay on its opening screen with nothing to explain why.
void import("./main").catch(() => {
  const message = document.getElementById("boot-message");
  if (message) message.textContent = "Wisp could not load. Check your connection to the server, then reload.";
});
