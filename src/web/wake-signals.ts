/**
 * Calls `onWake` when this page comes back: shown again (a phone that slept
 * or switched apps), resumed after the browser froze it, restored from the
 * back-forward cache, back online, or on another network. Going offline does
 * nothing: a server on this computer or a private network may still answer.
 */
export function watchBrowserWake(onWake: () => void, page: Window = window): void {
  const { document, navigator } = page;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onWake();
  });
  document.addEventListener("resume", onWake);
  page.addEventListener("pageshow", (event) => {
    if (event.persisted) onWake();
  });
  page.addEventListener("online", onWake);
  // Chromium only: fires when the connection type changes, such as Wi-Fi to cellular.
  (navigator as Navigator & { connection?: EventTarget }).connection?.addEventListener("change", onWake);
}
