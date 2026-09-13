import type { AppUpdater, UpdateInfo } from "electron-updater";

import type { UpdateState } from "../../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";
import type { StructuredLogger } from "./structured-logger.js";

type UpdateListener = (state: UpdateState) => void;

const MANUAL_UPDATE_MESSAGE = "This build cannot install updates automatically. Please update it manually.";

export class UpdateService {
  private state: UpdateState;
  private readonly listeners = new Set<UpdateListener>();

  constructor(
    private readonly updater: AppUpdater,
    currentVersion: string,
    private readonly enabled: boolean,
    private readonly autoInstallSupported = true,
    private readonly logger?: StructuredLogger,
  ) {
    this.state = enabled
      ? { phase: "idle", currentVersion }
      : { phase: "error", currentVersion, message: "Updates are available only in an installed release." };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
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
    return { ...this.state };
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
    await this.updater.downloadUpdate();
    return this.getState();
  }

  install(): void {
    this.assertEnabled();
    if (this.state.phase !== "downloaded")
      throw new WispBackendError("invalid_request", "No update is ready to install.");
    this.updater.quitAndInstall(false, true);
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
