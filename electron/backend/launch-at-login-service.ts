import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { LaunchAtLoginState } from "../../shared/contracts.js";
import { WispBackendError } from "./backend-error.js";

interface Options {
  platform: string;
  packaged: boolean;
  home: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
}

// Desktop Entry string escaping runs before Exec quoting; no shell is involved.
export function quoteDesktopExec(executable: string): string {
  if (!path.isAbsolute(executable) || /[\r\n\t\0=]/.test(executable)) {
    throw new WispBackendError("invalid_request", "The application path cannot be registered for launch at login.");
  }
  const quoted = executable.replace(/[\\"`$]/g, "\\$&").replace(/%/g, "%%");
  return `"${quoted.replace(/\\/g, "\\\\")}"`;
}

export class LaunchAtLoginService {
  private readonly file: string;
  private readonly executable: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: Options) {
    const config = options.env.XDG_CONFIG_HOME;
    this.file = path.join(
      config && path.isAbsolute(config) ? config : path.join(options.home, ".config"),
      "autostart",
      "wisp-bot.desktop",
    );
    this.executable = options.env.APPIMAGE || options.execPath;
  }

  async getState(): Promise<LaunchAtLoginState> {
    if (this.options.platform !== "linux")
      return { supported: false, enabled: false, reason: "Launch at login is currently available only on Linux." };
    if (!this.options.packaged)
      return {
        supported: false,
        enabled: false,
        reason: "Launch at login is available only in an installed Linux release.",
      };
    let contents: string;
    try {
      contents = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { supported: true, enabled: false };
      throw error;
    }
    const values = new Map<string, string>();
    let mainSection = false;
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) mainSection = trimmed === "[Desktop Entry]";
      else if (mainSection && !trimmed.startsWith("#")) {
        const separator = trimmed.indexOf("=");
        if (separator > 0) values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
      }
    }
    const enabled =
      values.get("Type") === "Application" &&
      values.get("Hidden") !== "true" &&
      values.get("X-GNOME-Autostart-enabled") !== "false" &&
      values.get("Exec") === quoteDesktopExec(this.executable);
    return { supported: true, enabled };
  }

  setEnabled(enabled: boolean): Promise<LaunchAtLoginState> {
    const operation = this.pending.then(async () => {
      const state = await this.getState();
      if (!state.supported)
        throw new WispBackendError("invalid_request", state.reason ?? "Launch at login is unavailable.");
      if (!enabled) {
        await rm(this.file, { force: true });
      } else {
        const exec = quoteDesktopExec(this.executable);
        await access(this.executable, constants.X_OK);
        await mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(
            temporary,
            `[Desktop Entry]\nType=Application\nName=Wisp Bot\nExec=${exec}\nTerminal=false\n`,
            { mode: 0o600, flag: "wx" },
          );
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      return this.getState();
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
