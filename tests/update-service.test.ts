import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { UpdateService } from "../electron/backend/update-service.js";

function updater() {
  const value = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  return value;
}

describe("UpdateService", () => {
  it("uses explicit check, download, and verified-updater install states", async () => {
    const adapter = updater();
    const service = new UpdateService(adapter as never, "1.0.0", true);
    expect(adapter.autoDownload).toBe(false);
    expect(adapter.allowDowngrade).toBe(false);

    const checking = service.check();
    adapter.emit("update-available", { version: "1.1.0" });
    await checking;
    expect(service.getState()).toMatchObject({ phase: "available", availableVersion: "1.1.0" });

    const downloading = service.download();
    adapter.emit("download-progress", { percent: 42 });
    adapter.emit("update-downloaded", { version: "1.1.0" });
    await downloading;
    expect(service.getState()).toMatchObject({ phase: "downloaded", progress: 100 });
    service.install();
    expect(adapter.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("reports offline errors safely and disables updates outside installed releases", async () => {
    const adapter = updater();
    const service = new UpdateService(adapter as never, "1.0.0", true);
    adapter.emit("error", new Error("token=secret raw network response"));
    expect(service.getState()).toEqual({
      phase: "error",
      currentVersion: "1.0.0",
      message: "The update service could not complete the request.",
    });
    await expect(service.download()).rejects.toMatchObject({ code: "invalid_request" });
    expect(adapter.downloadUpdate).not.toHaveBeenCalled();

    const unpackaged = new UpdateService(updater() as never, "1.0.0", false);
    await expect(unpackaged.check()).rejects.toMatchObject({ code: "invalid_request" });
  });
});
