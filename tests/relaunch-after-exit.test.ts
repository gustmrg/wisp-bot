import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { relaunchAfterExit } from "../electron/backend/relaunch-after-exit.js";

describe("relaunchAfterExit", () => {
  it("passes the pid, executable and arguments to a waiting shell", () => {
    const spawner = vi.fn();
    relaunchAfterExit(1234, "/opt/Wisp Bot/wisp-bot", ["--flag"], spawner);
    expect(spawner).toHaveBeenCalledWith("/bin/sh", [
      "-c",
      expect.any(String),
      "sh",
      "1234",
      "/opt/Wisp Bot/wisp-bot",
      "--flag",
    ]);
  });

  it.skipIf(process.platform === "win32")("starts the executable only after the process exits", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "wisp-relaunch-"));
    const marker = path.join(directory, "started");
    const executable = path.join(directory, "fake app");
    await writeFile(executable, `#!/bin/sh\necho "$@" > "${marker}"\n`, { mode: 0o755 });
    const waited = execFile("/bin/sh", ["-c", "sleep 0.5"]);
    const exited = new Promise((resolve) => waited.on("exit", resolve));

    let shell: Promise<void> = Promise.resolve();
    relaunchAfterExit(waited.pid as number, executable, ["--again"], (command, args) => {
      shell = new Promise((resolve, reject) => execFile(command, args, (error) => (error ? reject(error) : resolve())));
    });
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    await exited;
    await shell;
    expect(await readFile(marker, "utf8")).toBe("--again\n");
  });
});
