import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LaunchAtLoginService, quoteDesktopExec } from "../electron/backend/launch-at-login-service.js";
import { registerLaunchAtLoginHandlers } from "../electron/ipc/register-launch-at-login-handlers.js";
import { WISP_IPC_CHANNELS } from "../shared/contracts.js";
import type { IpcMainInvokeEvent } from "electron";

describe("Linux launch at login", () => {
  let home: string;
  let executable: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "wisp-login-"));
    executable = path.join(home, "Wisp Bot.AppImage");
    await writeFile(executable, "test");
    await chmod(executable, 0o700);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  function service(overrides: Partial<ConstructorParameters<typeof LaunchAtLoginService>[0]> = {}) {
    return new LaunchAtLoginService({
      platform: "linux",
      packaged: true,
      home,
      execPath: executable,
      env: {},
      ...overrides,
    });
  }
  const registration = (home: string) => path.join(home, ".config/autostart/wisp-bot.desktop");

  it("registers the installed executable, reads external disablement, and removes idempotently", async () => {
    const login = service();
    expect(await login.getState()).toEqual({ supported: true, enabled: false });
    expect(await login.setEnabled(true)).toEqual({ supported: true, enabled: true });
    const content = await readFile(registration(home), "utf8");
    expect(content).toContain(`Exec="${executable}"\n`);
    for (const flag of ["Hidden=true", "X-GNOME-Autostart-enabled=false"]) {
      await writeFile(registration(home), `${content}${flag}\n`);
      expect((await login.getState()).enabled).toBe(false);
    }
    await login.setEnabled(false);
    await login.setEnabled(false);
    await expect(readFile(registration(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses APPIMAGE instead of the mounted executable and respects XDG_CONFIG_HOME", async () => {
    const config = path.join(home, "custom config");
    const login = service({
      execPath: "/tmp/.mount_wisp/AppRun",
      env: { APPIMAGE: executable, XDG_CONFIG_HOME: config },
    });
    await login.setEnabled(true);
    expect(await readFile(path.join(config, "autostart/wisp-bot.desktop"), "utf8")).toContain(`Exec="${executable}"`);
  });

  it("ignores relative XDG paths and serializes changes", async () => {
    const login = service({ env: { XDG_CONFIG_HOME: "relative" } });
    await Promise.all([login.setEnabled(true), login.setEnabled(false)]);
    expect((await login.getState()).enabled).toBe(false);
  });

  it.each([{ platform: "darwin" }, { packaged: false }])(
    "does not touch autostart when unsupported: %o",
    async (options) => {
      const login = service(options);
      expect((await login.getState()).supported).toBe(false);
      await expect(login.setEnabled(true)).rejects.toThrow();
      await expect(readFile(registration(home))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("reports write failures and permits retry", async () => {
    await mkdir(path.join(home, ".config"));
    await writeFile(path.join(home, ".config/autostart"), "blocked");
    const login = service();
    await expect(login.setEnabled(true)).rejects.toThrow();
    await rm(path.join(home, ".config/autostart"));
    expect((await login.setEnabled(true)).enabled).toBe(true);
  });

  it("quotes Desktop Entry metacharacters without invoking a shell", () => {
    expect(quoteDesktopExec('/apps/Wisp $`"\\% Bot')).toBe('"/apps/Wisp \\\\$\\\\`\\\\"\\\\\\\\%% Bot"');
    expect(() => quoteDesktopExec("/apps/wisp\nHidden=false")).toThrow();
    expect(() => quoteDesktopExec("relative")).toThrow();
  });

  it("rejects untrusted IPC senders and malformed values", async () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, payload?: unknown) => unknown>();
    const login = service();
    const mutate = vi.spyOn(login, "setEnabled");
    let trusted = false;
    const registration = registerLaunchAtLoginHandlers(
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
        removeHandler: vi.fn(),
      },
      login,
      () => trusted,
    );
    const invoke = (payload: unknown) =>
      handlers.get(WISP_IPC_CHANNELS.setLaunchAtLogin)!({} as IpcMainInvokeEvent, payload);
    expect(await invoke(true)).toMatchObject({ ok: false });
    trusted = true;
    expect(await invoke("true")).toMatchObject({ ok: false });
    expect(mutate).not.toHaveBeenCalled();
    expect(await invoke(true)).toMatchObject({ ok: true, value: { enabled: true } });
    registration.dispose();
  });
});
