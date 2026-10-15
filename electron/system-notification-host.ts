import { app, BrowserWindow, nativeImage, Notification, type NativeImage } from "electron";

import type { SystemNotificationTarget } from "../shared/contracts.js";
import type { ConversationStateView } from "../shared/conversations.js";
import type { SystemNotificationHost } from "./system-notifications.js";

export interface ElectronNotificationHostOptions {
  /** The app icon shown in notifications where the system does not add it (Linux, Windows in development). */
  iconPath: string;
  /** Shows the app and the conversation a clicked notification is about. */
  open(target: SystemNotificationTarget): void;
  loadState(): Promise<ConversationStateView | undefined>;
}

function openWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
}

/**
 * Native notifications, the badge, and asking for attention, per platform:
 * macOS badges and bounces the Dock icon; Windows overlays a dot on the
 * taskbar button and flashes it; Linux sets the launcher count where the
 * desktop supports it (Unity, KDE) and flashes the window.
 */
export function createElectronNotificationHost(options: ElectronNotificationHostOptions): SystemNotificationHost {
  // Electron drops a notification's handlers once nothing references it.
  const shown = new Set<Notification>();
  let badgeDot: NativeImage | undefined;
  return {
    show({ title, body, target }) {
      if (!Notification.isSupported()) return;
      // With a window open, the app plays its own sounds.
      const notification = new Notification({
        title,
        body,
        silent: openWindows().length > 0,
        ...(process.platform === "darwin" ? {} : { icon: options.iconPath }),
      });
      shown.add(notification);
      const forget = (): void => {
        shown.delete(notification);
      };
      notification.on("click", () => {
        forget();
        if (target.conversationId) options.open(target);
      });
      notification.on("close", forget);
      notification.on("failed", forget);
      notification.show();
    },
    setBadge(count) {
      if (process.platform === "win32") {
        badgeDot ??= createBadgeDot();
        for (const window of openWindows()) {
          window.setOverlayIcon(count > 0 ? badgeDot : null, count > 0 ? `${count} waiting for you` : "");
        }
        return;
      }
      app.setBadgeCount(count);
    },
    requestAttention() {
      if (process.platform === "darwin") {
        app.dock?.bounce("informational");
        return;
      }
      for (const window of openWindows()) if (!window.isFocused()) window.flashFrame(true);
    },
    windowFocused: () => BrowserWindow.getFocusedWindow() !== null,
    loadState: options.loadState,
  };
}

/** A small red dot for the Windows taskbar overlay, drawn as a 16×16 BGRA bitmap. */
function createBadgeDot(): NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      // Anti-aliased edge over the last pixel of the radius.
      const alpha = Math.max(0, Math.min(1, size / 2 - distance));
      const offset = (y * size + x) * 4;
      // Skia bitmaps are premultiplied: each channel is scaled by the alpha.
      buffer[offset] = Math.round(0x2f * alpha); // B
      buffer[offset + 1] = Math.round(0x2f * alpha); // G
      buffer[offset + 2] = Math.round(0xe5 * alpha); // R
      buffer[offset + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}
