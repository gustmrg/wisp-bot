import { APP_METADATA } from "@/config/app-metadata";
import { SLOW_OPENING_MS } from "@/lib/opening";
import { browserDeviceName, createWebWispApi, takePairingCode } from "@/web/web-api";

// The browser app talks to the Wisp server that served it, through the same
// `window.wisp` the desktop app's preload exposes.
const pairingCode = takePairingCode(window.location, window.history);
Object.defineProperty(window, "wisp", {
  value: Object.freeze(
    createWebWispApi({
      origin: window.location.origin,
      storage: window.localStorage,
      deviceName: browserDeviceName(navigator.userAgent),
      appVersion: APP_METADATA.version,
      ...(pairingCode ? { pairingCode } : {}),
    }),
  ),
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
}

// The page's splash says so when the app is slow to arrive. Once the app
// starts it replaces the splash, and these find nothing to change.
function showBootNotice(text?: string): void {
  const notice = document.getElementById("boot-notice");
  const message = document.getElementById("boot-message");
  if (!notice || !message) return;
  if (text) message.textContent = text;
  notice.hidden = false;
  notice.style.display = "flex";
}
setTimeout(() => showBootNotice(), Math.max(0, SLOW_OPENING_MS - performance.now()));

// Without the app, the page would stay on its opening screen with nothing to explain why.
void import("./main").catch(() => {
  showBootNotice("Wisp could not load. Check your connection to the server, then reload.");
});
