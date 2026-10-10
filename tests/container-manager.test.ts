import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContainerCli, ContainerCommandResult, ContainerProcess } from "../backend/container-cli.js";
import { ContainerRuntimeDetector } from "../backend/container-cli.js";
import { ContainerManager, SANDBOX_DOCKERFILE, SANDBOX_IMAGE } from "../backend/container-manager.js";
import { EGRESS_PROXY_SCRIPT } from "../backend/egress-proxy.js";

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
  readonly containers = new Map<string, { running: boolean; spec: string; networks?: Set<string> }>();
  readonly images = new Set<string>();
  readonly networks = new Map<string, { internal: boolean }>();
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
        if (rest[1]!.includes("NetworkSettings")) {
          return ok(
            JSON.stringify(Object.fromEntries([...(container.networks ?? [])].map((network) => [network, {}]))),
          );
        }
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
      case "network": {
        const [action, ...network] = rest;
        switch (action) {
          case "inspect":
            return this.networks.has(name) ? ok("[]") : fail();
          case "create":
            this.networks.set(name, { internal: network.includes("--internal") });
            return ok();
          case "connect": {
            const container = this.containers.get(name)!;
            container.networks = new Set([...(container.networks ?? []), network.at(-2)!]);
            return ok();
          }
          case "disconnect":
            this.containers.get(name)?.networks?.delete(network.at(-2)!);
            return ok();
          case "rm":
            this.networks.delete(name);
            return ok();
          case "ls":
            return ok([...this.networks.keys()].join("\n"));
          default:
            return fail();
        }
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
  const spec = {
    storageId: "s1",
    image: SANDBOX_IMAGE,
    workspaceDirectory: path.join(root, "workspace"),
    localNetwork: true,
  };
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

describe("ContainerManager background processes", () => {
  it("starts the container for a new process and runs the start script with its arguments", async () => {
    const { cli, manager, spec, name } = await setup();
    const result = await manager.processScript(spec, "start", ["abcd1234", "npm run dev", "8"], { gitToken: "t0k" });

    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(cli.containers.get(name)?.running).toBe(true);
    const call = cli.calls.find(({ args }) => args[0] === "exec")!;
    expect(call.args.slice(0, 6)).toEqual(["exec", "-e", "WISP_GIT_TOKEN", "-w", "/workspace", name]);
    expect(call.args.slice(-4)).toEqual(["wisp-start", "abcd1234", "npm run dev", "8"]);
    expect(call.args[call.args.length - 5]).toContain("setsid");
    expect(call.env).toEqual({ WISP_GIT_TOKEN: "t0k" });
  });

  it("answers from a stopped container without starting it", async () => {
    const { cli, manager, spec, name } = await setup();
    await expect(manager.processScript(spec, "list", [])).resolves.toBeNull();
    await expect(manager.processScript(spec, "log", ["abcd1234", "50"])).resolves.toBeNull();
    expect(cli.containers.has(name)).toBe(false);
    expect(cli.calls.some(({ args }) => args[0] === "run")).toBe(false);
  });
});

describe("ContainerManager with the local network blocked", () => {
  it("puts the Wisp on its own internal network whose only way out is the egress proxy", async () => {
    const { cli, manager, spec, name, root } = await setup();
    const blocked = { ...spec, localNetwork: false };
    const network = manager.networkName("s1");
    const proxy = manager.proxyName();

    const first = manager.exec(blocked, "curl https://example.com", "/workspace", { onData: () => undefined });
    await finishNext(cli);
    await first;

    expect(cli.networks.get(network)).toEqual({ internal: true });
    const proxyRun = cli.calls.find(({ args }) => args[0] === "run" && args.includes(proxy))!.args;
    const script = path.join(root, "data", "containers", "egress-proxy.cjs");
    expect(proxyRun).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--cap-drop=ALL",
        `type=bind,source=${script},target=/opt/wisp/egress-proxy.cjs,readonly`,
        "node",
        SANDBOX_IMAGE,
      ]),
    );
    expect(proxyRun).not.toContain("--network");
    expect(await readFile(script, "utf8")).toBe(EGRESS_PROXY_SCRIPT);
    expect(cli.calls).toContainEqual({ args: ["network", "connect", "--alias", "wisp-egress", network, proxy] });
    const wispRun = cli.calls.find(({ args }) => args[0] === "run" && args.includes(name))!.args;
    expect(wispRun).toEqual(
      expect.arrayContaining([
        "--network",
        network,
        "HTTPS_PROXY=http://wisp-egress:3128",
        "https_proxy=http://wisp-egress:3128",
      ]),
    );

    const second = manager.exec(blocked, "true", "/workspace", { onData: () => undefined });
    await vi.waitFor(() => expect(cli.streams).toHaveLength(2));
    cli.streams[1]!.finish(0);
    await second;
    expect(cli.calls.filter(({ args }) => args[0] === "run")).toHaveLength(2);
    expect(cli.calls.filter(({ args }) => args[0] === "network" && args[1] === "create")).toHaveLength(1);
    expect(cli.calls.filter(({ args }) => args[0] === "network" && args[1] === "connect")).toHaveLength(1);
  });

  it("gives an allowed Wisp the default network and no proxy", async () => {
    const { cli, manager, spec, name } = await setup();
    const running = manager.exec(spec, "true", "/workspace", { onData: () => undefined });
    await finishNext(cli);
    await running;
    const wispRun = cli.calls.find(({ args }) => args[0] === "run" && args.includes(name))!.args;
    expect(wispRun).not.toContain("--network");
    expect(wispRun.join(" ")).not.toContain("PROXY");
    expect(cli.containers.has(manager.proxyName())).toBe(false);
  });

  it("reattaches a recreated proxy to the Wisp's network", async () => {
    const { cli, manager, spec } = await setup();
    const blocked = { ...spec, localNetwork: false };
    const first = manager.exec(blocked, "true", "/workspace", { onData: () => undefined });
    await finishNext(cli);
    await first;
    cli.containers.delete(manager.proxyName());

    const second = manager.exec(blocked, "true", "/workspace", { onData: () => undefined });
    await vi.waitFor(() => expect(cli.streams).toHaveLength(2));
    cli.streams[1]!.finish(0);
    await second;
    expect(cli.containers.get(manager.proxyName())!.networks).toEqual(new Set([manager.networkName("s1")]));
  });

  it("removes a Wisp's network with its container, and orphan networks but never the proxy", async () => {
    const { cli, manager, spec } = await setup();
    const running = manager.exec({ ...spec, localNetwork: false }, "true", "/workspace", { onData: () => undefined });
    await finishNext(cli);
    await running;
    cli.networks.set(manager.networkName("gone"), { internal: true });

    await manager.reconcile(new Set(["s1"]));
    expect([...cli.networks.keys()]).toEqual([manager.networkName("s1")]);
    expect(cli.containers.has(manager.proxyName())).toBe(true);

    await manager.remove("s1");
    expect(cli.networks.size).toBe(0);
    expect(cli.calls).toContainEqual({
      args: ["network", "disconnect", "-f", manager.networkName("s1"), manager.proxyName()],
    });
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
