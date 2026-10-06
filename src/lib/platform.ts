/** Whether this is the browser app served by a Wisp server, rather than the desktop app. */
export function isBrowserApp(): boolean {
  return document.documentElement.dataset.wispPlatform === "web";
}
