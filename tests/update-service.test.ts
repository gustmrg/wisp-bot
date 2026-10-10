import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { StructuredLogger, type LogSink } from "../backend/structured-logger.js";
import { UpdateService } from "../electron/backend/update-service.js";

function updater() {
  const value = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    autoRunAppAfterInstall: true,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  return value;
}

function loggingSink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (value: string) => lines.push(value),
    warn: (value: string) => lines.push(value),
  };
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
    expect(service.getState()).toMatchObject({ phase: "downloading", progress: 0, availableVersion: "1.1.0" });
    adapter.emit("download-progress", { percent: 42 });
    adapter.emit("update-downloaded", { version: "1.1.0" });
    await downloading;
    expect(service.getState()).toMatchObject({ phase: "downloaded", progress: 100 });
    vi.useFakeTimers();
    try {
      service.install();
      // The renderer sees "installing" before the app starts shutting down.
      expect(service.getState()).toMatchObject({ phase: "installing", availableVersion: "1.1.0" });
      expect(adapter.quitAndInstall).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(adapter.quitAndInstall).toHaveBeenCalledWith(false, true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("relaunches through its own hook only after a package-manager install succeeds", async () => {
    const adapter = updater();
    const relaunch = vi.fn();
    const service = new UpdateService(adapter as never, "1.0.0", true, true, undefined, undefined, relaunch);
    expect(adapter.autoRunAppAfterInstall).toBe(false);
    const downloadAndInstall = async () => {
      const checking = service.check();
      adapter.emit("update-available", { version: "1.1.0" });
      await checking;
      const downloading = service.download();
      adapter.emit("update-downloaded", { version: "1.1.0" });
      await downloading;
      service.install();
      vi.runAllTimers();
    };

    vi.useFakeTimers();
    try {
      await downloadAndInstall();
      expect(adapter.quitAndInstall).toHaveBeenCalledWith(false, false);
      expect(relaunch).toHaveBeenCalledTimes(1);

      // pkexec failing (or the password prompt being dismissed) keeps the app open.
      adapter.quitAndInstall.mockImplementationOnce(() => adapter.emit("error", new Error("pkexec exited with 127")));
      await downloadAndInstall();
      expect(relaunch).toHaveBeenCalledTimes(1);
      expect(service.getState()).toMatchObject({ phase: "error" });
      expect(adapter.listenerCount("error")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the version this launch was updated from in every state", () => {
    const adapter = updater();
    const service = new UpdateService(adapter as never, "1.1.0", true, true, undefined, "1.0.0");
    expect(service.getState()).toEqual({ phase: "idle", currentVersion: "1.1.0", updatedFrom: "1.0.0" });
    adapter.emit("update-not-available");
    expect(service.getState()).toEqual({ phase: "up-to-date", currentVersion: "1.1.0", updatedFrom: "1.0.0" });
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

  it("routes found updates to manual download when auto-install is unsupported", async () => {
    const adapter = updater();
    const service = new UpdateService(adapter as never, "1.0.0", true, false);

    adapter.emit("update-available", { version: "1.1.0" });
    expect(service.getState()).toEqual({
      phase: "manual-download",
      currentVersion: "1.0.0",
      availableVersion: "1.1.0",
      message: "This build cannot install updates automatically. Please update it manually.",
    });

    await expect(service.download()).rejects.toMatchObject({ code: "invalid_request" });
    expect(adapter.downloadUpdate).not.toHaveBeenCalled();
    expect(() => service.install()).toThrow(/No update is ready to install/);
    expect(adapter.quitAndInstall).not.toHaveBeenCalled();
  });

  it("keeps in-app download states when auto-install is supported", async () => {
    const adapter = updater();
    const service = new UpdateService(adapter as never, "1.0.0", true, true);
    adapter.emit("update-available", { version: "1.1.0" });
    expect(service.getState()).toMatchObject({ phase: "available", availableVersion: "1.1.0" });
  });

  it("logs redacted updater errors while keeping the user-facing message stable", () => {
    const adapter = updater();
    const sink = loggingSink();
    const service = new UpdateService(adapter as never, "1.0.0", true, true, new StructuredLogger(sink));

    adapter.emit("error", new Error("HttpError: 404 for GET https://github.com example token sk-abcdefghijklmnop1234"));

    expect(service.getState()).toMatchObject({
      phase: "error",
      message: "The update service could not complete the request.",
    });
    expect(sink.lines).toHaveLength(1);
    const record = JSON.parse(sink.lines[0]) as { event: string; message: string };
    expect(record.event).toBe("update_error");
    expect(record.message).toContain("HttpError: 404");
    expect(record.message).toContain("[REDACTED]");
    expect(record.message).not.toContain("sk-abcdefghijklmnop1234");
  });

  it("leaves the downloading state when the download fails without an updater event", async () => {
    const adapter = updater();
    adapter.downloadUpdate.mockRejectedValueOnce(new Error("socket hang up"));
    const service = new UpdateService(adapter as never, "1.0.0", true);
    const checking = service.check();
    adapter.emit("update-available", { version: "1.1.0" });
    await checking;
    await expect(service.download()).rejects.toThrow("socket hang up");
    expect(service.getState()).toMatchObject({ phase: "error" });
  });
});
