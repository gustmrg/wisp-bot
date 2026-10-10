import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerCli, ContainerCommandResult, ContainerProcess } from "../backend/container-cli.js";
import { ContainerRuntimeDetector } from "../backend/container-cli.js";
import { ContainerManager, SANDBOX_DOCKERFILE, SANDBOX_IMAGE } from "../backend/container-manager.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A container program that keeps containers in memory and records every call; it never runs anything. */
class FakeCli implements ContainerCli {
  readonly calls: Array<{ args: string[]; input?: string; env?: Record<string, string> }> = [];
  readonly streams: Array<{
    args: string[];
    env?: Record<string, string>;
    finish: (code: number | null) => void;
    killed: boolean;
  }> = [];
  readonly containers = new Map<string, { running: boolean; spec: string }>();
  readonly images = new Set<string>();
  createFails = false;

  constructor(readonly name: "docker" | "podman" = "docker") {}

  async run(args: ReadonlyArray<string>, options: { input?: string; env?: Record<string, string> } = {}) {
    this.calls.push({ args: [...args], ...options });
    const ok = (stdout = ""): ContainerCommandResult => ({ exitCode: 0, stdout, stderr: "" });
    const fail = (stderr = "No such object"): ContainerCommandResult => ({ exitCode: 1, stdout: "", stderr });
    const [command, ...rest] = args;
    const name = rest.at(-1)!;
    switch (command) {
      case "inspect": {
        const container = this.containers.get(name);
        if (!container) return fail();
        return ok(
          rest[1]!.includes("wisp.spec") ? `${container.running} ${container.spec}` : String(container.running),
        );
      }
      case "start":
        this.containers.get(name)!.running = true;
        return ok();
      case "stop":
        for (const stopped of rest.slice(2)) {
          const container = this.containers.get(stopped);
          if (container) container.running = false;
        }
        return ok();
      case "rm":
        this.containers.delete(name);
        return ok();
      case "image":
        return this.images.has(name) ? ok() : fail();
      case "build":
        this.images.add(rest[rest.indexOf("-t") + 1]!);
        return ok();
      case "pull":
        this.images.add(name);
        return ok();
      case "run": {
        if (this.createFails) return fail("permission denied");
        const label = rest.find((value) => value.startsWith("wisp.spec="))!;
        this.containers.set(rest[rest.indexOf("--name") + 1]!, {
          running: true,
          spec: label.slice("wisp.spec=".length),
        });
        return ok("id");
      }
      case "ps": {
        const runningOnly = !rest.includes("-a");
        return ok(
          [...this.containers]
            .filter(([, container]) => !runningOnly || container.running)
            .map(([containerName]) => containerName)
            .join("\n"),
        );
      }
      default:
        return ok();
    }
  }

  stream(args: ReadonlyArray<string>, options: { onData: (data: Buffer) => void; env?: Record<string, string> }) {
    let finish!: (code: number | null) => void;
    const done = new Promise<number | null>((resolve) => {
      finish = resolve;
    });
    const entry = { args: [...args], ...(options.env ? { env: options.env } : {}), finish, killed: false };
    this.streams.push(entry);
    options.onData(Buffer.from("output\n"));
    const process: ContainerProcess = {
      done,
      kill: () => {
        entry.killed = true;
        finish(null);
      },
    };
    return process;
  }
}

async function setup(options: { cli?: FakeCli; idleMs?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-containers-"));
  directories.push(root);
  const cli = options.cli ?? new FakeCli();
  const manager = new ContainerManager({
    cli: async () => cli,
    dataDirectory: path.join(root, "data"),
    uid: 1000,
    gid: 1000,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  const spec = { storageId: "s1", image: SANDBOX_IMAGE, workspaceDirectory: path.join(root, "workspace") };
  return { root, cli, manager, spec, name: manager.containerName("s1") };
}

async function finishNext(cli: FakeCli, code = 0) {
  await vi.waitFor(() => expect(cli.streams.length).toBeGreaterThan(0));
  cli.streams.at(-1)!.finish(code);
}

describe("ContainerManager", () => {
  it("builds the sandbox image once, creates a confined container and runs the command in it", async () => {
    const { cli, manager, spec, name } = await setup();
    const output: string[] = [];

    const running = manager.exec(spec, "git status", "/workspace/repo", {
      onData: (data) => output.push(String(data)),
    });
    await finishNext(cli, 3);

    await expect(running).resolves.toEqual({ exitCode: 3 });
    const build = cli.calls.find(({ args }) => args[0] === "build")!;
    expect(build.input).toBe(SANDBOX_DOCKERFILE);
    expect(build.args).toContain(SANDBOX_IMAGE);
    const run = cli.calls.find(({ args }) => args[0] === "run")!.args;
    expect(run).toEqual(
      expect.arrayContaining([
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        `type=bind,source=${spec.workspaceDirectory},target=/workspace`,
        SANDBOX_IMAGE,
      ]),
    );
    expect(run).not.toContain("--privileged");
    expect(run.join(" ")).not.toMatch(/docker\.sock/);
    // The home folder lives in the workspace, created by the server so it owns it.
    expect((await stat(path.join(spec.workspaceDirectory, ".home"))).isDirectory()).toBe(true);
    const exec = cli.streams[0]!.args;
    expect(exec.slice(0, 4)).toEqual(["exec", "-w", "/workspace/repo", name]);
    expect(exec.at(-1)).toBe("git status");
    expect(output.join("")).toContain("Building the Wisp sandbox image");
  });

  it("reuses a running container and recreates one made from other settings", async () => {
    const { cli, manager, spec, name } = await setup();
    const first = manager.exec(spec, "true", "/workspace", { onData: () => undefined });
    await finishNext(cli);
    await first;
    const second = manager.exec(spec, "true", "/workspace", { onData: () => undefined });
    await vi.waitFor(() => expect(cli.streams).toHaveLength(2));
    cli.streams[1]!.finish(0);
    await second;
    expect(cli.calls.filter(({ args }) => args[0] === "run")).toHaveLength(1);

    cli.images.add("node:22");
    const changed = manager.exec({ ...spec, image: "node:22" }, "true", "/workspace", { onData: () => undefined });
    await vi.waitFor(() => expect(cli.streams).toHaveLength(3));
    cli.streams[2]!.finish(0);
    await changed;
    expect(cli.calls.filter(({ args }) => args[0] === "rm")).toEqual([{ args: ["rm", "-f", name] }]);
    expect(cli.calls.filter(({ args }) => args[0] === "run")).toHaveLength(2);
  });

  it("passes the git token through the environment, never as an argument", async () => {
    const { cli, manager, spec } = await setup();
    const running = manager.exec(spec, "git push", "/workspace", { onData: () => undefined, gitToken: "ghp_secret" });
    await finishNext(cli);
    await running;

    const stream = cli.streams[0]!;
    expect(stream.env).toEqual({ WISP_GIT_TOKEN: "ghp_secret" });
    expect(stream.args).toContain("WISP_GIT_TOKEN");
    expect(JSON.stringify([...cli.calls.map(({ args }) => args), stream.args])).not.toContain("ghp_secret");
  });

  it("kills the command's processes on cancel and reports it as aborted", async () => {
    const { cli, manager, spec, name } = await setup();
    const controller = new AbortController();
    const running = manager.exec(spec, "sleep 100", "/workspace", {
      onData: () => undefined,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(cli.streams).toHaveLength(1));

    controller.abort();
    await vi.waitFor(() =>
      expect(cli.calls.some(({ args }) => args[0] === "exec" && args[1] === name && args[2] === "bash")).toBe(true),
    );
    cli.streams[0]!.finish(137);

    await expect(running).rejects.toThrow("aborted");
    const execId = cli.streams[0]!.args.at(-2);
    expect(cli.calls.find(({ args }) => args[2] === "bash")!.args.at(-1)).toBe(execId);
  });

  it("reports a timeout like the shell tool does", async () => {
    const { cli, manager, spec } = await setup();
    const running = manager.exec(spec, "sleep 100", "/workspace", { onData: () => undefined, timeout: 0.05 });
    await vi.waitFor(() => expect(cli.calls.some(({ args }) => args[2] === "bash")).toBe(true));
    cli.streams[0]!.finish(137);
    await expect(running).rejects.toThrow("timeout:0.05");
    await expect(manager.exec(spec, "true", "/workspace", { onData: () => undefined, timeout: -1 })).rejects.toThrow(
      "Invalid timeout",
    );
  });

  it("stops the container after it has been idle", async () => {
    const { cli, manager, spec, name } = await setup({ idleMs: 30 });
    const running = manager.exec(spec, "true", "/workspace", { onData: () => undefined });
    await finishNext(cli);
    await running;
    expect(await manager.state("s1")).toBe("running");

    await vi.waitFor(() => expect(cli.calls.some(({ args }) => args[0] === "stop" && args.includes(name))).toBe(true));
    expect(await manager.state("s1")).toBe("stopped");
  });

  it("explains a container that cannot be created", async () => {
    const cli = new FakeCli();
    cli.createFails = true;
    const { manager, spec } = await setup({ cli });
    await expect(manager.exec(spec, "true", "/workspace", { onData: () => undefined })).rejects.toMatchObject({
      message: expect.stringContaining("permission denied"),
    });
  });

  it("keeps workspace files owned by the server's user under rootless Podman", async () => {
    const { cli, manager, spec } = await setup({ cli: new FakeCli("podman") });
    const running = manager.exec(spec, "true", "/workspace", { onData: () => undefined });
    await finishNext(cli);
    await running;
    expect(cli.calls.find(({ args }) => args[0] === "run")!.args).toContain("--userns=keep-id");
  });

  it("removes containers of deleted Wisps and stops the rest on shutdown", async () => {
    const { cli, manager } = await setup();
    const kept = manager.containerName("kept");
    const gone = manager.containerName("gone");
    cli.containers.set(kept, { running: true, spec: "x" });
    cli.containers.set(gone, { running: false, spec: "x" });

    await manager.reconcile(new Set(["kept"]));
    expect([...cli.containers.keys()]).toEqual([kept]);

    await manager.dispose();
    expect(cli.containers.get(kept)!.running).toBe(false);
  });
});

describe("ContainerRuntimeDetector", () => {
  const program = (name: "docker" | "podman", result: ContainerCommandResult): ContainerCli => ({
    name,
    run: async () => result,
    stream: () => {
      throw new Error("unused");
    },
  });

  it("prefers Docker and falls back to Podman", async () => {
    const detector = new ContainerRuntimeDetector([
      program("docker", { exitCode: 127, stdout: "", stderr: "ENOENT" }),
      program("podman", { exitCode: 0, stdout: "5.4.0\n", stderr: "" }),
    ]);
    await expect(detector.status()).resolves.toEqual({ available: true, name: "podman", version: "5.4.0" });
    expect((await detector.cli())?.name).toBe("podman");
  });

  it("tells an installed but stopped service apart from a missing program", async () => {
    const stopped = new ContainerRuntimeDetector([program("docker", { exitCode: 1, stdout: "", stderr: "daemon" })]);
    await expect(stopped.status()).resolves.toMatchObject({
      available: false,
      message: expect.stringContaining("Docker is installed"),
    });
    await expect(new ContainerRuntimeDetector([]).status()).resolves.toMatchObject({
      available: false,
      message: expect.stringContaining("Install Docker or Podman"),
    });
  });
});
