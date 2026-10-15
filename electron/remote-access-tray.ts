import { Menu, nativeImage, Tray } from "electron";

export interface RemoteAccessTrayOptions {
  /** A PNG of the app icon; it is scaled down for the tray. */
  iconPath: string;
  openWindow(): void;
  quit(): void;
}

/**
 * The tray icon shown while remote access to this computer is on. Closing
 * every window then leaves the app, and its Wisps, running for other devices;
 * quitting from here stops them.
 */
export class RemoteAccessTray {
  private tray: Tray | undefined;

  constructor(private readonly options: RemoteAccessTrayOptions) {}

  setVisible(visible: boolean): void {
    if (!visible) {
      this.tray?.destroy();
      this.tray = undefined;
      return;
    }
    if (this.tray) return;
    const icon = nativeImage.createFromPath(this.options.iconPath).resize({ width: 16, height: 16 });
    const tray = new Tray(icon);
    tray.setToolTip("Wisp: remote access is on");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Remote access is on", enabled: false },
        { type: "separator" },
        { label: "Open Wisp", click: () => this.options.openWindow() },
        { label: "Quit Wisp", click: () => this.options.quit() },
      ]),
    );
    // Linux shows the menu on click; elsewhere a click opens the window.
    tray.on("click", () => this.options.openWindow());
    this.tray = tray;
  }
}
