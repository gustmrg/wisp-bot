import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerManager } from "../backend/container-manager.js";
import { SANDBOX_IMAGE } from "../backend/container-manager.js";
import { containerPath, ExecutionService, PROCESS_TOOL, RUN_COMMAND_TOOL } from "../backend/execution-service.js";
import { WORKSPACE_SETTINGS_FILE } from "../backend/workspace-service.js";
import type { ContainerRuntimeStatus } from "../shared/execution.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const encryption = {
  isAvailable: () => true,
  encrypt: (value: string) => Buffer.from(value.split("").reverse().join("")),
  decrypt: (value: Buffer) => value.toString().split("").reverse().join(""),
};

async function setup(options: { runtime?: ContainerRuntimeStatus } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-execution-"));
  directories.push(root);
  const wisp = {
    storageId: "s1",
    workspaceDirectory: path.join(root, "workspaces", "s1"),
    configDirectory: path.join(root, "config", "s1"),
  };
  await mkdir(wisp.workspaceDirectory, { recursive: true });
  const manager = {
    state: vi.fn(async () => "absent" as const),
    exec: vi.fn(async (_spec: unknown, _command: string, _cwd: string, exec: { onData: (data: Buffer) => void }) => {
      exec.onData(Buffer.from("On branch main\n"));
      return { exitCode: 0 };
    }),
    remove: vi.fn(async () => undefined),
    processScript: vi.fn(
      async (
        _spec: unknown,
        _action: string,
        _args: ReadonlyArray<string>,
      ): Promise<{ exitCode: number; stdout: string } | null> => ({
        exitCode: 0,
        stdout: "",
      }),
    ),
    reconcile: vi.fn(async () => undefined),
  };
  const authorize = vi.fn(async () => undefined);
  const service = new ExecutionService({
    dataDirectory: root,
    encryption,
    resolveWisp: (id) => {
      if (id !== "atlas") throw new Error("not a Wisp");
      return wisp;
    },
    listWispStorageIds: () => new Set(["s1"]),
    authorizationBroker: { authorize },
    manager: manager as unknown as ContainerManager,
    runtime: {
      status: async () => options.runtime ?? { available: true, name: "docker", version: "29.0.0" },
      cli: async () => null,
    },
  });
  return { root, wisp, manager, authorize, service };
}

type RunCommand = {
  name: string;
  execute: (
    id: string,
    params: { command: string; timeout?: number },
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

async function runCommandTool(service: ExecutionService): Promise<RunCommand> {
  const snapshot = await service.getSnapshot("atlas");
  return snapshot.definitions.find(({ name }) => name === RUN_COMMAND_TOOL) as unknown as RunCommand;
}

describe("ExecutionService", () => {
  it("starts with commands off and offers no tool", async () => {
    const { service } = await setup();
    await expect(service.getView("atlas")).resolves.toEqual({
      mode: "off",
      image: null,
      localNetwork: false,
      defaultImage: SANDBOX_IMAGE,
      hasGitToken: false,
      runtime: { available: true, name: "docker", version: "29.0.0" },
      container: "absent",
    });
    await expect(service.getSnapshot("atlas")).resolves.toMatchObject({ definitions: [], activeNames: [] });
    await expect(service.getSnapshot("circle")).resolves.toMatchObject({ definitions: [], activeNames: [] });
  });

  it("offers run_command once commands run in a container, and a new revision when the image changes", async () => {
    const { service, manager } = await setup();
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    const first = await service.getSnapshot("atlas");
    expect(first.activeNames).toEqual([RUN_COMMAND_TOOL, PROCESS_TOOL]);
    expect(first.definitions.map(({ name }) => name)).toEqual([RUN_COMMAND_TOOL, PROCESS_TOOL]);
    // Settings changes drop the old container so the next command gets one made from them.
    expect(manager.remove).toHaveBeenCalledWith("s1");

    await service.save({ conversationId: "atlas", mode: "container", image: "node:22", localNetwork: false });
    expect((await service.getSnapshot("atlas")).revision).not.toBe(first.revision);
  });

  it("blocks the local network unless allowed, and recreates the container when that changes", async () => {
    const { service, manager } = await setup();
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    const blocked = await service.getSnapshot("atlas");
    const description = (blocked.definitions[0] as unknown as { description: string }).description;
    expect(description).toContain("Local and private network addresses are blocked");
    manager.remove.mockClear();

    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: true });
    expect(manager.remove).toHaveBeenCalledWith("s1");
    const open = await service.getSnapshot("atlas");
    expect(open.revision).not.toBe(blocked.revision);
    expect((open.definitions[0] as unknown as { description: string }).description).toContain(
      "the local network are reachable",
    );
  });

  it("offers no tool while no container program is available", async () => {
    const { service } = await setup({ runtime: { available: false, message: "Install Docker" } });
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    await expect(service.getSnapshot("atlas")).resolves.toMatchObject({ activeNames: [] });
  });

  it("refuses images that could be read as options", async () => {
    const { service } = await setup();
    for (const image of ["--privileged", "a b", "x".repeat(300), "a//b"]) {
      await expect(
        service.save({ conversationId: "atlas", mode: "container", image, localNetwork: false }),
      ).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
  });

  it("keeps the GitHub token encrypted and never returns it", async () => {
    const { service, root } = await setup();
    const view = await service.save({
      conversationId: "atlas",
      mode: "container",
      image: null,
      localNetwork: false,
      gitToken: "ghp_secret",
    });
    expect(view.hasGitToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain("ghp_secret");
    expect(await readFile(path.join(root, "execution-credentials.enc.json"), "utf8")).not.toContain("ghp_secret");

    await expect(
      service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false, gitToken: null }),
    ).resolves.toMatchObject({ hasGitToken: false });
  });

  it("runs a command in the container after authorizing it, with the token and the container path", async () => {
    const { service, manager, authorize, wisp } = await setup();
    await service.save({
      conversationId: "atlas",
      mode: "container",
      image: null,
      localNetwork: false,
      gitToken: "ghp_secret",
    });
    const tool = await runCommandTool(service);

    const result = await tool.execute("call-1", { command: "git status" });

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "atlas",
        toolName: RUN_COMMAND_TOOL,
        category: "container_command",
        scope: { kind: "container", value: "Wisp container" },
      }),
      undefined,
    );
    expect(manager.exec).toHaveBeenCalledWith(
      { storageId: "s1", image: SANDBOX_IMAGE, workspaceDirectory: wisp.workspaceDirectory, localNetwork: false },
      "git status",
      "/workspace",
      expect.objectContaining({ gitToken: "ghp_secret" }),
    );
    // The server's environment is never handed to the container.
    expect(manager.exec.mock.calls[0]![3]).not.toHaveProperty("env");
    expect(result.content[0]?.text).toContain("On branch main");
  });

  it("refuses commands that would wipe the workspace, without running them", async () => {
    const { service, manager, authorize } = await setup();
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    const tool = await runCommandTool(service);
    for (const command of ["rm -rf /", "rm -rf ~", "cd x && rm -rf /workspace", "rm -rf .", ":(){ :|:& };:"]) {
      await expect(tool.execute("call", { command })).rejects.toThrow("was not run");
    }
    expect(manager.exec).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();

    for (const command of ["rm -rf ./build", "rm -rf node_modules", "rm -f *.log", "rm -rf /tmp/cache"]) {
      await tool.execute("call", { command });
    }
    expect(manager.exec).toHaveBeenCalledTimes(4);
  });

  it("refuses commands while the workspace holds more than its size", async () => {
    const { service, manager, wisp } = await setup();
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    await writeFile(path.join(wisp.configDirectory, WORKSPACE_SETTINGS_FILE), JSON.stringify({ quotaBytes: 4 }));
    await writeFile(path.join(wisp.workspaceDirectory, "big.txt"), "12345");
    const tool = await runCommandTool(service);

    await expect(tool.execute("call", { command: "ls" })).rejects.toMatchObject({
      message: expect.stringContaining("workspace is full"),
    });
    expect(manager.exec).not.toHaveBeenCalled();
  });

  it("forgets the tokens and containers of deleted Wisps", async () => {
    const { service, manager } = await setup();
    await service.save({
      conversationId: "atlas",
      mode: "container",
      image: null,
      localNetwork: false,
      gitToken: "ghp_secret",
    });
    await service.reconcile();
    expect(manager.reconcile).toHaveBeenCalledWith(new Set(["s1"]));
    await expect(service.getView("atlas")).resolves.toMatchObject({ hasGitToken: true });
  });
});

type ProcessTool = {
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};

describe("process tool", () => {
  async function processSetup() {
    const context = await setup();
    await context.service.save({
      conversationId: "atlas",
      mode: "container",
      image: null,
      localNetwork: false,
      gitToken: "ghp_secret",
    });
    const snapshot = await context.service.getSnapshot("atlas");
    const tool = snapshot.definitions.find(({ name }) => name === PROCESS_TOOL) as unknown as ProcessTool;
    const text = async (params: Record<string, unknown>) => (await tool.execute("call", params)).content[0]!.text;
    return { ...context, tool, text };
  }

  it("starts a process after authorizing it and reports its id and first output", async () => {
    const { manager, authorize, text, wisp } = await processSetup();
    manager.processScript.mockResolvedValueOnce({ exitCode: 0, stdout: "Listening on :3000\n" });

    const answer = await text({ action: "start", command: "npm run dev" });

    const id = /Started process ([a-f0-9]{8})\./.exec(answer)?.[1];
    expect(id).toBeDefined();
    expect(answer).toContain("Listening on :3000");
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: PROCESS_TOOL, category: "container_command" }),
      undefined,
    );
    expect(manager.processScript).toHaveBeenCalledWith(
      { storageId: "s1", image: SANDBOX_IMAGE, workspaceDirectory: wisp.workspaceDirectory, localNetwork: false },
      "start",
      [id, "npm run dev", "8"],
      { gitToken: "ghp_secret" },
    );
  });

  it("refuses starts over the limit, harmful commands and a full workspace", async () => {
    const { manager, text, wisp } = await processSetup();
    manager.processScript.mockResolvedValueOnce({ exitCode: 3, stdout: "limit\n" });
    await expect(text({ action: "start", command: "sleep 100" })).rejects.toThrow("already running");
    await expect(text({ action: "start", command: "rm -rf /" })).rejects.toThrow("was not run");
    await writeFile(path.join(wisp.configDirectory, WORKSPACE_SETTINGS_FILE), JSON.stringify({ quotaBytes: 1 }));
    await writeFile(path.join(wisp.workspaceDirectory, "big.txt"), "12");
    await expect(text({ action: "start", command: "sleep 100" })).rejects.toThrow("workspace is full");
    expect(manager.processScript).toHaveBeenCalledTimes(1);
  });

  it("lists, reads, waits for and stops processes", async () => {
    const { manager, text } = await processSetup();
    const started = Math.floor(Date.now() / 1000) - 120;
    manager.processScript.mockResolvedValueOnce({
      exitCode: 0,
      stdout: `abcd1234\trunning\t${started}\tnpm run dev\nffff0000\texited 1\t${started}\tnpm test\n`,
    });
    expect(await text({ action: "list" })).toBe(
      "abcd1234  running  started 2 min ago  npm run dev\nffff0000  exited 1  started 2 min ago  npm test",
    );

    manager.processScript.mockResolvedValueOnce({ exitCode: 0, stdout: "line 1\nline 2\n" });
    expect(await text({ action: "log", id: "abcd1234", lines: 9999 })).toBe("line 1\nline 2");
    expect(manager.processScript).toHaveBeenLastCalledWith(expect.anything(), "log", ["abcd1234", "500"], {});

    manager.processScript.mockResolvedValueOnce({ exitCode: 0, stdout: "exited 0\nall tests passed\n" });
    expect(await text({ action: "wait", id: "abcd1234", timeout: 60 })).toBe(
      "Process exited 0.\nLast output:\nall tests passed",
    );
    expect(manager.processScript).toHaveBeenLastCalledWith(expect.anything(), "wait", ["abcd1234", "60", "50"], {});

    manager.processScript.mockResolvedValueOnce({ exitCode: 0, stdout: "running\n" });
    expect(await text({ action: "wait", id: "abcd1234", timeout: 5 })).toBe(
      "Still running after 5 seconds.\nNo output.",
    );

    expect(await text({ action: "kill", id: "abcd1234" })).toBe("Process abcd1234 stopped.");
    manager.processScript.mockResolvedValueOnce({ exitCode: 4, stdout: "" });
    expect(await text({ action: "log", id: "00000000" })).toContain("There is no process 00000000");
    manager.processScript.mockResolvedValueOnce(null);
    expect(await text({ action: "list" })).toContain("container is not running");
  });

  it("rejects malformed requests before touching the container", async () => {
    const { manager, text } = await processSetup();
    await expect(text({ action: "log", id: "../../etc" })).rejects.toThrow("Give the id");
    await expect(text({ action: "start" })).rejects.toThrow("Give the command");
    await expect(text({ action: "exec" })).rejects.toThrow("action must be");
    expect(manager.processScript).not.toHaveBeenCalled();
  });
});

describe("containerPath", () => {
  it("maps workspace folders and keeps everything else in the workspace", () => {
    expect(containerPath("/data/w", "/data/w")).toBe("/workspace");
    expect(containerPath("/data/w", "/data/w/repo/src")).toBe("/workspace/repo/src");
    expect(containerPath("/data/w", "/etc")).toBe("/workspace");
    expect(containerPath("/data/w", "/data/w2")).toBe("/workspace");
  });
});
