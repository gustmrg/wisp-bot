import type { AppUpdater, UpdateInfo } from "electron-updater";

import type { UpdateState } from "../../shared/contracts.js";
import { WispBackendError } from "../../backend/backend-error.js";
import type { StructuredLogger } from "../../backend/structured-logger.js";

type UpdateListener = (state: UpdateState) => void;

const MANUAL_UPDATE_MESSAGE = "This build cannot install updates automatically. Please update it manually.";
// quitAndInstall starts shutting the app down at once, so the renderer gets
// this long to receive and paint the "installing" state first.
const INSTALL_PAINT_DELAY_MS = 300;

export class UpdateService {
  private state: UpdateState;
  private readonly listeners = new Set<UpdateListener>();

  constructor(
    private readonly updater: AppUpdater,
    currentVersion: string,
    private readonly enabled: boolean,
    private readonly autoInstallSupported = true,
    private readonly logger?: StructuredLogger,
    private readonly updatedFrom?: string,
    // Replaces the updater's own relaunch after an install; see relaunch-after-exit.ts.
    private readonly relaunchAfterInstall?: () => void,
  ) {
    this.state = enabled
      ? { phase: "idle", currentVersion }
      : { phase: "error", currentVersion, message: "Updates are available only in an installed release." };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    if (relaunchAfterInstall) updater.autoRunAppAfterInstall = false;
    updater.on("checking-for-update", () => this.setState({ phase: "checking", currentVersion }));
    updater.on("update-available", (info: UpdateInfo) => {
      if (!this.autoInstallSupported) {
        this.setState({
          phase: "manual-download",
          currentVersion,
          availableVersion: info.version,
          message: MANUAL_UPDATE_MESSAGE,
        });
        return;
      }
      this.setState({ phase: "available", currentVersion, availableVersion: info.version });
    });
    updater.on("update-not-available", () => this.setState({ phase: "up-to-date", currentVersion }));
    updater.on("download-progress", (progress) =>
      this.setState({ ...this.state, phase: "downloading", currentVersion, progress: Math.round(progress.percent) }),
    );
    updater.on("update-downloaded", (info: UpdateInfo) =>
      this.setState({ phase: "downloaded", currentVersion, availableVersion: info.version, progress: 100 }),
    );
    updater.on("error", (error: Error) => {
      // The updater's own messages can be long and multi-line; the redacted,
      // single-line record goes to the log sink while the UI keeps a stable text.
      this.logger?.warn("update_error", { message: error.message });
      this.setState({ phase: "error", currentVersion, message: "The update service could not complete the request." });
    });
  }

  getState(): UpdateState {
    return this.updatedFrom ? { ...this.state, updatedFrom: this.updatedFrom } : { ...this.state };
  }

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async check(): Promise<UpdateState> {
    this.assertEnabled();
    this.setState({ phase: "checking", currentVersion: this.state.currentVersion });
    await this.updater.checkForUpdates();
    return this.getState();
  }

  async download(): Promise<UpdateState> {
    this.assertEnabled();
    if (this.state.phase !== "available") {
      throw new WispBackendError("invalid_request", "No update is available to download.");
    }
    // The updater's first progress event arrives about a second in, and a
    // cached download reports none, so leave "available" before it starts.
    this.setState({ ...this.state, phase: "downloading", progress: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      if (this.getState().phase === "downloading") {
        this.setState({
          phase: "error",
          currentVersion: this.state.currentVersion,
          message: "The update service could not complete the request.",
        });
      }
      throw error;
    }
    return this.getState();
  }

  install(): void {
    this.assertEnabled();
    if (this.state.phase !== "downloaded")
      throw new WispBackendError("invalid_request", "No update is ready to install.");
    this.setState({ ...this.state, phase: "installing" });
    setTimeout(() => this.quitAndInstall(), INSTALL_PAINT_DELAY_MS);
  }

  private quitAndInstall(): void {
    if (!this.relaunchAfterInstall) {
      this.updater.quitAndInstall(false, true);
      return;
    }
    // The install runs synchronously and reports a failure through the "error"
    // event, in which case the app keeps running and must not start a second copy.
    let failed = false;
    const onError = () => {
      failed = true;
    };
    this.updater.on("error", onError);
    try {
      this.updater.quitAndInstall(false, false);
    } finally {
      this.updater.off("error", onError);
    }
    if (!failed) this.relaunchAfterInstall();
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new WispBackendError("invalid_request", "Updates are available only in an installed release.");
    }
  }

  private setState(state: UpdateState): void {
    this.state = state;
    for (const listener of this.listeners) listener(this.getState());
  }
}
