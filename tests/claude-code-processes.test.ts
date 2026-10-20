import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeProcesses } from "../backend/claude-code/claude-code-processes.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ClaudeCodeProcesses", () => {
  it("waits for the processes started in a workspace to exit", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "wisp-claude-code-processes-"));
    directories.push(workspace);
    const processes = new ClaudeCodeProcesses();
    // A stand-in for Claude Code that exits once its input ends, as Claude Code does.
    const child = processes.spawn({
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(0), 100));"],
      cwd: workspace,
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    });
    let exited = false;
    child.once("exit", () => (exited = true));

    child.stdin!.end();
    await processes.whenExited(workspace);

    expect(exited).toBe(true);
    // Nothing runs there any more, so the next wait is immediate.
    await processes.whenExited(workspace, 0);
  });

  it("gives up waiting after the timeout", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "wisp-claude-code-processes-"));
    directories.push(workspace);
    const processes = new ClaudeCodeProcesses();
    const stop = new AbortController();
    const child = processes.spawn({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: workspace,
      env: { PATH: process.env.PATH },
      signal: stop.signal,
    });
    child.once("error", () => undefined);

    await processes.whenExited(workspace, 50);

    expect(child.exitCode).toBeNull();
    stop.abort();
    await processes.whenExited(workspace);
  });
});
