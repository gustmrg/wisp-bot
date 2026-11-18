import { describe, expect, it } from "vitest";

import type { ClaudeCodeStatusView } from "../shared/claude-code.js";
import { ClaudeCodeActivity } from "../backend/claude-code/claude-code-activity.js";
import {
  ClaudeCodeUpdateService,
  resolveClaudeCodeInstall,
  type ClaudeCodeInstall,
  type UpdateRunner,
} from "../backend/claude-code/claude-code-update.js";

function probe(real: string, writable = true) {
  return { realpath: async () => real, writable: async () => writable };
}

describe("resolveClaudeCodeInstall", () => {
  it("updates only installs whose path proves the installer", async () => {
    await expect(
      resolveClaudeCodeInstall("/home/pi/.local/bin/claude", probe("/home/pi/.local/share/claude/versions/2.1.200")),
    ).resolves.toEqual({ method: "native", executable: "/home/pi/.local/bin/claude" });
    await expect(
      resolveClaudeCodeInstall(
        "C:\\Users\\ada\\.local\\bin\\claude.exe",
        probe("C:\\Users\\ada\\.local\\bin\\claude.exe"),
      ),
    ).resolves.toMatchObject({ method: "native" });

    const npm = "/home/pi/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    await expect(resolveClaudeCodeInstall("/home/pi/.npm-global/bin/claude", probe(npm))).resolves.toEqual({
      method: "npm",
      prefix: "/home/pi/.npm-global",
    });
    // A system prefix only root can write is left to the person.
    await expect(
      resolveClaudeCodeInstall(
        "/usr/bin/claude",
        probe("/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", false),
      ),
    ).resolves.toEqual({ method: "manual", command: "npm install -g @anthropic-ai/claude-code@latest" });

    await expect(
      resolveClaudeCodeInstall("/opt/homebrew/bin/claude", probe("/opt/homebrew/Caskroom/claude-code/2.1.200/claude")),
    ).resolves.toEqual({ method: "manual", command: "brew upgrade --cask claude-code" });
    await expect(resolveClaudeCodeInstall("/usr/local/bin/claude", probe("/usr/local/bin/claude"))).resolves.toEqual({
      method: "manual",
    });
  });
});

const outdated: ClaudeCodeStatusView = { state: "outdated", version: "2.1.200", minimumVersion: "2.1.276" };
const ready: ClaudeCodeStatusView = { state: "ready", version: "2.1.303", billing: "subscription" };

function setup(options: { install?: ClaudeCodeInstall; run?: UpdateRunner; after?: ClaudeCodeStatusView } = {}) {
  let status = outdated;
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const activity = new ClaudeCodeActivity();
  const service = new ClaudeCodeUpdateService({
    status: { refresh: async () => status, executable: () => "/home/pi/.local/bin/claude" },
    activity,
    resolve: async () => options.install ?? { method: "native", executable: "/home/pi/.local/bin/claude" },
    run: async (command, args, env) => {
      calls.push({ command, args });
      const result = options.run ? await options.run(command, args, env) : { exitCode: 0, output: "" };
      if (result.exitCode === 0) status = options.after ?? ready;
      return result;
    },
    now: () => new Date("2026-11-18T12:00:00Z"),
  });
  return { service, activity, calls };
}

describe("ClaudeCodeUpdateService", () => {
  it("runs the native updater in the background and reports the new version", async () => {
    const { service, calls } = setup();
    await expect(service.view()).resolves.toEqual({ method: "native", running: false });

    await service.start();
    expect((await service.view())?.running).toBe(true);
    await expect(service.start()).rejects.toMatchObject({ message: "Claude Code is already being updated." });
    await service.whenDone();

    expect(calls).toEqual([{ command: "/home/pi/.local/bin/claude", args: ["update"] }]);
    await expect(service.view()).resolves.toEqual({
      method: "native",
      running: false,
      last: { ok: true, message: "Updated to Claude Code 2.1.303.", finishedAt: "2026-11-18T12:00:00.000Z" },
    });
  });

  it("installs the latest npm package into the prefix that owns claude", async () => {
    const { service, calls } = setup({ install: { method: "npm", prefix: "/home/pi/.npm-global" } });
    await service.start();
    await service.whenDone();
    expect(calls[0]?.args).toEqual([
      "install",
      "--global",
      "--prefix",
      "/home/pi/.npm-global",
      "@anthropic-ai/claude-code@latest",
    ]);
  });

  it("waits for Claude Code turns and never runs an installer it cannot prove", async () => {
    const busy = setup();
    const endTurn = busy.activity.begin();
    await expect(busy.service.start()).rejects.toMatchObject({
      code: "invalid_request",
      message: "Wait for Wisps on Claude Code to finish before updating it.",
    });
    endTurn();
    await busy.service.start();
    await busy.service.whenDone();

    const manual = setup({ install: { method: "manual", command: "brew upgrade --cask claude-code" } });
    await expect(manual.service.start()).rejects.toMatchObject({
      code: "configuration_required",
      message:
        "Wisp cannot update this Claude Code install. Run `brew upgrade --cask claude-code` on the server's computer.",
    });
    expect(manual.calls).toEqual([]);
  });

  it("reports a failed update by the line that names the error", async () => {
    const failed = setup({
      run: async () => ({
        exitCode: 1,
        output:
          "Checking for updates...\nError: EACCES: permission denied, open '/usr/local/claude'\nTry running claude doctor",
      }),
    });
    await failed.service.start();
    await failed.service.whenDone();
    expect((await failed.service.view())?.last).toMatchObject({
      ok: false,
      message: "Error: EACCES: permission denied, open '/usr/local/claude'",
    });

    // An updater that exits 0 without updating is caught by checking the version again.
    const stuck = setup({ after: outdated });
    await stuck.service.start();
    await stuck.service.whenDone();
    expect((await stuck.service.view())?.last).toMatchObject({
      ok: false,
      message: "The update finished, but Claude Code is still 2.1.200.",
    });
  });
});
