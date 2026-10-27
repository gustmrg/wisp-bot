import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerManager } from "../backend/container-manager.js";
import { SANDBOX_IMAGE } from "../backend/container-manager.js";
import type { GitForges } from "../backend/egress-proxy.js";
import { containerPath, ExecutionService, PROCESS_TOOL, RUN_COMMAND_TOOL } from "../backend/execution-service.js";
import { WORKSPACE_SETTINGS_FILE } from "../backend/workspace-service.js";
import { WORKSPACE_DISK_RESERVE_BYTES } from "../shared/workspace.js";
import type { ContainerRuntimeStatus } from "../shared/execution.js";
import { ownConversation } from "../backend/integration-tool-source.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(
  options: {
    runtime?: ContainerRuntimeStatus;
    gitForges?: (conversationId: string) => Promise<GitForges>;
    freeDiskBytes?: (directory: string) => Promise<number>;
  } = {},
) {
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
  const browser = { close: vi.fn(async () => undefined) };
  const service = new ExecutionService({
    dataDirectory: root,
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
    ...(options.gitForges ? { gitForges: options.gitForges } : {}),
    ...(options.freeDiskBytes ? { freeDiskBytes: options.freeDiskBytes } : {}),
    browser,
  });
  return { root, wisp, manager, authorize, browser, service };
}

type RunCommand = {
  name: string;
  execute: (
    id: string,
    params: { command: string; timeout?: number; description?: string },
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>;
  parameters: { properties: Record<string, { type?: string }>; required?: string[] };
};

async function runCommandTool(service: ExecutionService): Promise<RunCommand> {
  const snapshot = await service.getSnapshot(ownConversation("atlas"));
  return snapshot.definitions.find(({ name }) => name === RUN_COMMAND_TOOL) as unknown as RunCommand;
}

describe("ExecutionService", () => {
  it("starts with commands off and offers no tool", async () => {
    const { service } = await setup();
    await expect(service.getView("atlas")).resolves.toEqual({
      mode: "off",
      image: null,
      localNetwork: false,
      browser: false,
      defaultImage: SANDBOX_IMAGE,
      gitHubPlugin: false,
      gitLabInstance: null,
      runtime: { available: true, name: "docker", version: "29.0.0" },
      container: "absent",
    });
    await expect(service.getSnapshot(ownConversation("atlas"))).resolves.toMatchObject({
      definitions: [],
      activeNames: [],
    });
    await expect(service.getSnapshot({ conversationId: "circle", wispId: "atlas" })).resolves.toMatchObject({
      definitions: [],
      activeNames: [],
    });
  });

  it("offers run_command once commands run in a container, and a new revision when the image changes", async () => {
    const { service, manager } = await setup();
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    const first = await service.getSnapshot(ownConversation("atlas"));
    expect(first.activeNames).toEqual([RUN_COMMAND_TOOL, PROCESS_TOOL]);
    expect(first.definitions.map(({ name }) => name)).toEqual([RUN_COMMAND_TOOL, PROCESS_TOOL]);
    // Settings changes drop the old container so the next command gets one made from them.
    expect(manager.remove).toHaveBeenCalledWith("s1");

    await service.save({ conversationId: "atlas", mode: "container", image: "node:22", localNetwork: false });
    expect((await service.getSnapshot(ownConversation("atlas"))).revision).not.toBe(first.revision);
  });

  it("turns the browser on and off apart from commands, closing it but keeping the container", async () => {
    const { service, manager, browser, wisp } = await setup();
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    manager.remove.mockClear();

    await expect(
      service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false, browser: true }),
    ).resolves.toMatchObject({ browser: true });
    // Left out, it stays as it is.
    await expect(
      service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false }),
    ).resolves.toMatchObject({ browser: true });
    expect(JSON.parse(await readFile(path.join(wisp.configDirectory, "execution-settings.json"), "utf8"))).toEqual({
      mode: "container",
      image: null,
      localNetwork: false,
      browser: true,
    });
    expect(browser.close).not.toHaveBeenCalled();

    await service.save({
      conversationId: "atlas",
      mode: "container",
      image: null,
      localNetwork: false,
      browser: false,
    });
    expect(browser.close).toHaveBeenCalledWith("s1");
    expect(manager.remove).not.toHaveBeenCalled();
  });

  it("blocks the local network unless allowed, and recreates the container when that changes", async () => {
    const { service, manager } = await setup();
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    const blocked = await service.getSnapshot(ownConversation("atlas"));
    const description = (blocked.definitions[0] as unknown as { description: string }).description;
    expect(description).toContain("Local and private network addresses are blocked");
    manager.remove.mockClear();

    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: true });
    expect(manager.remove).toHaveBeenCalledWith("s1");
    const open = await service.getSnapshot(ownConversation("atlas"));
    expect(open.revision).not.toBe(blocked.revision);
    expect((open.definitions[0] as unknown as { description: string }).description).toContain(
      "the local network are reachable",
    );
  });

  it("offers no tool while no container program is available", async () => {
    const { service } = await setup({ runtime: { available: false, message: "Install Docker" } });
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    await expect(service.getSnapshot(ownConversation("atlas"))).resolves.toMatchObject({ activeNames: [] });
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

  it("runs a command in the container after authorizing it, with the token and the container path", async () => {
    const { service, manager, authorize, wisp } = await setup({
      gitForges: async () => ({ github: { token: "ghp_secret" } }),
    });
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
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
      expect.objectContaining({ git: { github: { token: "ghp_secret" } } }),
    );
    // The server's environment is never handed to the container.
    expect(manager.exec.mock.calls[0]![3]).not.toHaveProperty("env");
    expect(result.content[0]?.text).toContain("On branch main");
  });

  it("takes a description of the command and records how it ended", async () => {
    const { service, manager } = await setup();
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    const tool = await runCommandTool(service);
    expect(tool.parameters.properties.description).toMatchObject({ type: "string" });
    expect(tool.parameters.required).toEqual(["command"]);

    manager.exec.mockResolvedValueOnce({ exitCode: 2 });
    const result = await tool.execute("call-1", { command: "npm test", description: "Run the tests" });

    expect(manager.exec).toHaveBeenCalledWith(expect.anything(), "npm test", "/workspace", expect.anything());
    expect(result.details?.commandResult).toEqual({ exitCode: 2, durationMs: expect.any(Number) });
  });

  it("gives git the GitHub plugin's token when the Wisp has access to the plugin", async () => {
    const gitForges = vi.fn(async (conversationId: string) =>
      conversationId === "atlas" ? { github: { token: "github_pat_plugin" } } : {},
    );
    const { service, manager } = await setup({ gitForges });
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    await expect(service.getView("atlas")).resolves.toMatchObject({ gitHubPlugin: true });
    const tool = await runCommandTool(service);

    await tool.execute("call-1", { command: "git clone https://github.com/owner/private" });

    expect(gitForges).toHaveBeenCalledWith("atlas");
    expect(manager.exec.mock.calls[0]![3]).toMatchObject({ git: { github: { token: "github_pat_plugin" } } });
  });

  it("gives git the GitLab plugin's instance and token, and leaves out an instance it cannot use", async () => {
    const forges: { current: GitForges } = {
      current: { gitlab: { upstream: "https://gitlab.example.invalid/gitlab", token: "glpat-plugin" } },
    };
    const { service, manager } = await setup({ gitForges: async () => forges.current });
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    await expect(service.getView("atlas")).resolves.toMatchObject({
      gitHubPlugin: false,
      gitLabInstance: "https://gitlab.example.invalid/gitlab",
    });
    const tool = await runCommandTool(service);
    await tool.execute("call-1", { command: "git clone https://gitlab.example.invalid/gitlab/group/project" });
    expect(manager.exec.mock.calls[0]![3]).toMatchObject({ git: forges.current });

    for (const upstream of ["http://gitlab.example.invalid", "https://gitlab.example.invalid/", "not a url"]) {
      forges.current = { gitlab: { upstream, token: "glpat-plugin" } };
      await expect(service.getView("atlas")).resolves.toMatchObject({ gitLabInstance: null });
    }
  });

  it("runs commands without a token when the plugin's cannot be read", async () => {
    const { service, manager } = await setup({
      gitForges: async () => {
        throw new Error("secure storage unavailable");
      },
    });
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    await expect(service.getView("atlas")).resolves.toMatchObject({ gitHubPlugin: false });
    const tool = await runCommandTool(service);

    await tool.execute("call-1", { command: "git status" });

    expect(manager.exec.mock.calls[0]![3]).toMatchObject({ git: {} });
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

  it("runs commands in a workspace without a size until its disk is down to the reserve", async () => {
    let free = 2 * WORKSPACE_DISK_RESERVE_BYTES;
    const { service, manager, wisp } = await setup({ freeDiskBytes: async () => free });
    await service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    await writeFile(
      path.join(wisp.configDirectory, WORKSPACE_SETTINGS_FILE),
      JSON.stringify({ quotaBytes: 4, unlimited: true }),
    );
    // Past the size it once had.
    await writeFile(path.join(wisp.workspaceDirectory, "big.txt"), "12345");
    const tool = await runCommandTool(service);

    await tool.execute("call", { command: "ls" });
    expect(manager.exec).toHaveBeenCalledTimes(1);
    free = WORKSPACE_DISK_RESERVE_BYTES - 1;
    await expect(tool.execute("call", { command: "ls" })).rejects.toMatchObject({
      message: expect.stringContaining("before running more commands"),
    });
    expect(manager.exec).toHaveBeenCalledTimes(1);
  });

  it("removes the containers of deleted Wisps and the tokens once saved for each Wisp", async () => {
    const { service, manager, root } = await setup();
    const legacy = path.join(root, "execution-credentials.enc.json");
    await writeFile(legacy, "{}");
    await service.reconcile();
    expect(manager.reconcile).toHaveBeenCalledWith(new Set(["s1"]));
    await expect(readFile(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    await service.reconcile();
  });
});

type ProcessTool = {
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};

describe("process tool", () => {
  async function processSetup() {
    const context = await setup({ gitForges: async () => ({ github: { token: "ghp_secret" } }) });
    await context.service.save({ conversationId: "atlas", mode: "container", image: null, localNetwork: false });
    const snapshot = await context.service.getSnapshot(ownConversation("atlas"));
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
      { git: { github: { token: "ghp_secret" } } },
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
    expect(await text({ action: "log", id: "abcd1234", lines: 500 })).toBe("line 1\nline 2");
    expect(manager.processScript).toHaveBeenLastCalledWith(expect.anything(), "log", ["abcd1234", "500"], {});
    await expect(text({ action: "log", id: "abcd1234", lines: 9999 })).rejects.toThrow("Invalid lines: Too big");

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
