import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AttachedContainerProcess,
  ContainerCli,
  ContainerCommandResult,
  ContainerProcess,
} from "../backend/container-cli.js";
import { ContainerRuntimeDetector } from "../backend/container-cli.js";
import { BROWSER_DOCKERFILE, BROWSER_DRIVER_SCRIPT, BROWSER_IMAGE } from "../backend/browser-driver.js";
import { ContainerManager, SANDBOX_DOCKERFILE, SANDBOX_IMAGE } from "../backend/container-manager.js";
import { EGRESS_PROXY_SCRIPT, type GitForges } from "../backend/egress-proxy.js";

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
  readonly containers = new Map<
    string,
    { running: boolean; spec: string; startedAt?: string; networks?: Map<string, string> }
  >();
  readonly images = new Set<string>();
  readonly networks = new Map<string, { internal: boolean }>();
  readonly attached: Array<{
    args: string[];
    written: string[];
    ended: boolean;
    finish: (code: number | null) => void;
  }> = [];
  createFails = false;
  private starts = 0;
  private addresses = 0;

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
          const networks = Object.fromEntries(
            [...(container.networks ?? [])].map(([network, address]) => [network, { IPAddress: address }]),
          );
          return ok(`${JSON.stringify(container.startedAt)} ${JSON.stringify(networks)}`);
        }
        return ok(
          rest[1]!.includes("wisp.spec") ? `${container.running} ${container.spec}` : String(container.running),
        );
      }
      case "start":
        Object.assign(this.containers.get(name)!, { running: true, startedAt: `start-${++this.starts}` });
        return ok();
      case "stop":
        for (const stopped of rest.slice(2)) {
          const container = this.containers.get(stopped);
          if (container) container.running = false;
        }
        return ok();
      case "rm":
        for (const removed of rest.filter((value) => !value.startsWith("-"))) this.containers.delete(removed);
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
          startedAt: `start-${++this.starts}`,
        });
        return ok("id");
      }
      case "network": {
        const [action, ...network] = rest;
        switch (action) {
          case "inspect": {
            const found = this.networks.get(name);
            return found ? ok(`${found.internal}\n`) : fail();
          }
          case "create":
            this.networks.set(name, { internal: network.includes("--internal") });
            return ok();
          case "connect": {
            const container = this.containers.get(name)!;
            container.networks = new Map(container.networks ?? []);
            container.networks.set(network.at(-2)!, `172.30.${++this.addresses}.2`);
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

  attach(args: ReadonlyArray<string>): AttachedContainerProcess {
    let finish!: (code: number | null) => void;
    const done = new Promise<number | null>((resolve) => {
      finish = resolve;
    });
    const entry = { args: [...args], written: [] as string[], ended: false, finish };
    this.attached.push(entry);
    return {
      done,
      write: (data) => entry.written.push(data),
      end: () => {
        entry.ended = true;
        finish(0);
      },
      kill: () => finish(null),
    };
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

/** What the manager told the git gateway, in order. */
function gatewayCalls(cli: FakeCli, manager: ContainerManager): Array<{ address: string; forges: GitForges | null }> {
  return cli.calls
    .filter(({ args }) => args[0] === "exec" && args.includes(manager.proxyName()) && args.at(-1) === "control")
    .map(({ args, input }) => {
      expect(args).toEqual(["exec", "-i", manager.proxyName(), "node", "/opt/wisp/egress-proxy.cjs", "control"]);
      return JSON.parse(input!) as { address: string; forges: GitForges | null };
    });
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
    const run = cli.calls.find(({ args }) => args[0] === "run" && args.includes(name))!.args;
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
    expect(exec.slice(0, 1)).toEqual(["exec"]);
    expect(exec.slice(exec.indexOf("-w"), exec.indexOf("-w") + 3)).toEqual(["-w", "/workspace/repo", name]);
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
    const wispRuns = () => cli.calls.filter(({ args }) => args[0] === "run" && args.includes(name));
    expect(wispRuns()).toHaveLength(1);

    cli.images.add("node:22");
    const changed = manager.exec({ ...spec, image: "node:22" }, "true", "/workspace", { onData: () => undefined });
    await vi.waitFor(() => expect(cli.streams).toHaveLength(3));
    cli.streams[2]!.finish(0);
    await changed;
    expect(cli.calls.filter(({ args }) => args[0] === "rm")).toEqual([{ args: ["rm", "-f", name] }]);
    expect(wispRuns()).toHaveLength(2);
  });

  it("never gives the container the git token, only the gateway, on standard input", async () => {
    const { cli, manager, spec, name } = await setup();
    const running = manager.exec(spec, "git push", "/workspace", {
      onData: () => undefined,
      git: { github: { token: "ghp_secret" } },
    });
    await finishNext(cli);
    await running;

    const wispRun = cli.calls.find(({ args }) => args[0] === "run" && args.includes(name))!.args;
    expect(wispRun.join(" ")).not.toContain("GIT_CONFIG");
    expect(wispRun.join(" ")).not.toContain("credential");
    const stream = cli.streams[0]!;
    // Each command sends github.com to the gateway, under the forge's name.
    expect(stream.args.slice(0, stream.args.indexOf("-w"))).toEqual([
      "exec",
      "-e",
      "GIT_CONFIG_COUNT=1",
      "-e",
      "GIT_CONFIG_KEY_0=url.http://wisp-egress:3129/github/.insteadOf",
      "-e",
      "GIT_CONFIG_VALUE_0=https://github.com/",
    ]);
    expect(stream.env).toBeUndefined();
    const everything = JSON.stringify([...cli.calls.map(({ args, env }) => ({ args, env })), stream.args]);
    expect(everything).not.toContain("ghp_secret");
    expect(gatewayCalls(cli, manager)).toEqual([
      { address: "172.30.1.2", forges: { github: { token: "ghp_secret" } } },
    ]);
  });

  it("sends the GitLab plugin's instance to the gateway, and gives the gateway its token", async () => {
    const { cli, manager, spec } = await setup();
    const git = { gitlab: { upstream: "https://gitlab.example.invalid/gitlab", token: "glpat_secret" } };
    const running = manager.exec(spec, "git fetch", "/workspace", { onData: () => undefined, git });
    await finishNext(cli);
    await running;

    const stream = cli.streams[0]!;
    expect(stream.args.slice(0, stream.args.indexOf("-w"))).toEqual([
      "exec",
      "-e",
      "GIT_CONFIG_COUNT=2",
      "-e",
      "GIT_CONFIG_KEY_0=url.http://wisp-egress:3129/github/.insteadOf",
      "-e",
      "GIT_CONFIG_VALUE_0=https://github.com/",
      "-e",
      "GIT_CONFIG_KEY_1=url.http://wisp-egress:3129/gitlab/.insteadOf",
      "-e",
      "GIT_CONFIG_VALUE_1=https://gitlab.example.invalid/gitlab/",
    ]);
    expect(JSON.stringify(stream.args)).not.toContain("glpat_secret");
    expect(gatewayCalls(cli, manager)).toEqual([{ address: "172.30.1.2", forges: git }]);
  });

  it("tells the gateway again only when the token or the proxy changed", async () => {
    const { cli, manager, spec } = await setup();
    const run = async (gitToken?: string) => {
      const count = cli.streams.length;
      const running = manager.exec(spec, "git fetch", "/workspace", {
        onData: () => undefined,
        ...(gitToken ? { git: { github: { token: gitToken } } } : {}),
      });
      await vi.waitFor(() => expect(cli.streams).toHaveLength(count + 1));
      cli.streams.at(-1)!.finish(0);
      await running;
    };

    await run("one");
    await run("one");
    expect(gatewayCalls(cli, manager)).toHaveLength(1);
    await run("two");
    await run();
    expect(gatewayCalls(cli, manager).slice(1)).toEqual([
      { address: "172.30.1.2", forges: { github: { token: "two" } } },
      { address: "172.30.1.2", forges: {} },
    ]);

    // A restarted proxy has forgotten its tokens.
    cli.containers.get(manager.proxyName())!.running = false;
    await run();
    expect(gatewayCalls(cli, manager).at(-1)).toEqual({ address: "172.30.1.2", forges: {} });
    expect(gatewayCalls(cli, manager)).toHaveLength(4);

    await manager.remove("s1");
    expect(gatewayCalls(cli, manager)).toHaveLength(5);
    expect(gatewayCalls(cli, manager).at(-1)).toEqual({ address: "172.30.1.2", forges: null });
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
    const result = await manager.processScript(spec, "start", ["abcd1234", "npm run dev", "8"], {
      git: { github: { token: "t0k" } },
    });

    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(cli.containers.get(name)?.running).toBe(true);
    const call = cli.calls.find(({ args }) => args[0] === "exec" && args.includes(name))!;
    const workdir = call.args.indexOf("-w");
    expect(call.args.slice(0, workdir)).toContain("GIT_CONFIG_VALUE_0=https://github.com/");
    expect(call.args.slice(workdir, workdir + 3)).toEqual(["-w", "/workspace", name]);
    expect(call.args.slice(-4)).toEqual(["wisp-start", "abcd1234", "npm run dev", "8"]);
    expect(call.args[call.args.length - 5]).toContain("setsid");
    expect(call.env).toBeUndefined();
    expect(gatewayCalls(cli, manager)).toEqual([{ address: "172.30.1.2", forges: { github: { token: "t0k" } } }]);
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
    expect(proxyRun).toEqual(expect.arrayContaining(["--network", manager.proxyNetworkName()]));
    expect(cli.networks.get(manager.proxyNetworkName())).toEqual({ internal: false });
    expect(await readFile(script, "utf8")).toBe(EGRESS_PROXY_SCRIPT);
    expect(cli.calls).toContainEqual({ args: ["network", "connect", "--alias", "wisp-egress", network, proxy] });
    const wispRun = cli.calls.find(({ args }) => args[0] === "run" && args.includes(name))!.args;
    expect(wispRun).toEqual(
      expect.arrayContaining([
        "--network",
        network,
        "HTTPS_PROXY=http://wisp-egress:3128",
        "https_proxy=http://wisp-egress:3128",
        // The git gateway is on the Wisp's network, not behind the proxy.
        "NO_PROXY=localhost,127.0.0.1,::1,wisp-egress",
      ]),
    );

    const second = manager.exec(blocked, "true", "/workspace", { onData: () => undefined });
    await vi.waitFor(() => expect(cli.streams).toHaveLength(2));
    cli.streams[1]!.finish(0);
    await second;
    expect(cli.calls.filter(({ args }) => args[0] === "run")).toHaveLength(2);
    expect(
      cli.calls.filter(({ args }) => args[0] === "network" && args[1] === "create" && args.at(-1) === network),
    ).toHaveLength(1);
    expect(cli.calls.filter(({ args }) => args[0] === "network" && args[1] === "connect")).toHaveLength(1);
  });

  it("gives an allowed Wisp a network of its own with a route out, the git gateway and no proxy", async () => {
    const { cli, manager, spec, name } = await setup();
    const network = manager.networkName("s1");
    const running = manager.exec(spec, "true", "/workspace", { onData: () => undefined });
    await finishNext(cli);
    await running;
    expect(cli.networks.get(network)).toEqual({ internal: false });
    const wispRun = cli.calls.find(({ args }) => args[0] === "run" && args.includes(name))!.args;
    expect(wispRun).toEqual(expect.arrayContaining(["--network", network]));
    expect(wispRun.join(" ")).not.toContain("PROXY");
    expect([...cli.containers.get(manager.proxyName())!.networks!.keys()]).toEqual([network]);
  });

  it("recreates a network left from other settings, so a blocked Wisp never keeps a route out", async () => {
    const { cli, manager, spec, name } = await setup();
    const network = manager.networkName("s1");
    const allowed = manager.exec(spec, "true", "/workspace", { onData: () => undefined });
    await finishNext(cli);
    await allowed;

    // As if the setting changed while the server could not remove the old network.
    cli.containers.delete(name);
    const blocked = manager.exec({ ...spec, localNetwork: false }, "true", "/workspace", { onData: () => undefined });
    await vi.waitFor(() => expect(cli.streams).toHaveLength(2));
    cli.streams[1]!.finish(0);
    await blocked;
    expect(cli.networks.get(network)).toEqual({ internal: true });
    expect(cli.calls).toContainEqual({ args: ["network", "rm", network] });
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
    expect([...cli.containers.get(manager.proxyName())!.networks!.keys()]).toEqual([manager.networkName("s1")]);
  });

  it("removes a Wisp's network with its container, and orphan networks but never the proxy or its network", async () => {
    const { cli, manager, spec } = await setup();
    const running = manager.exec({ ...spec, localNetwork: false }, "true", "/workspace", { onData: () => undefined });
    await finishNext(cli);
    await running;
    cli.networks.set(manager.networkName("gone"), { internal: true });

    await manager.reconcile(new Set(["s1"]));
    expect([...cli.networks.keys()].sort()).toEqual([manager.networkName("s1"), manager.proxyNetworkName()].sort());
    expect(cli.containers.has(manager.proxyName())).toBe(true);

    await manager.remove("s1");
    expect([...cli.networks.keys()]).toEqual([manager.proxyNetworkName()]);
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

describe("ContainerManager browsers", () => {
  it("starts a confined browser on the Wisp's blocked network, through the proxy, without the workspace", async () => {
    const { cli, manager, spec, root } = await setup();
    const blocked = { storageId: spec.storageId, localNetwork: false };

    const browser = await manager.startBrowser(blocked, { onStdout: () => undefined });

    const build = cli.calls.find(({ args }) => args[0] === "build" && args.includes(BROWSER_IMAGE))!;
    expect(build.input).toBe(BROWSER_DOCKERFILE);
    const network = manager.networkName("s1");
    expect(cli.networks.get(network)).toEqual({ internal: true });
    const driver = path.join(root, "data", "containers", "browser-driver.cjs");
    expect(await readFile(driver, "utf8")).toBe(BROWSER_DRIVER_SCRIPT);
    const { args } = cli.attached[0]!;
    expect(args.slice(0, 5)).toEqual(["run", "-i", "--rm", "--name", manager.browserName("s1")]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--network",
        network,
        "WISP_BROWSER_PROXY=http://wisp-egress:3128",
        `type=bind,source=${driver},target=/opt/wisp/browser-driver.cjs,readonly`,
        BROWSER_IMAGE,
      ]),
    );
    expect(args.join(" ")).not.toContain(spec.workspaceDirectory);
    // The browser leaves the git gateway's token to the commands.
    expect(gatewayCalls(cli, manager)).toEqual([]);

    await manager.closeBrowser("s1", browser);
    expect(cli.attached[0]!.ended).toBe(true);
  });

  it("lets a browser allowed the local network go straight out", async () => {
    const { cli, manager } = await setup();
    await manager.startBrowser({ storageId: "s1", localNetwork: true }, { onStdout: () => undefined });
    expect(cli.networks.get(manager.networkName("s1"))).toEqual({ internal: false });
    expect(cli.attached[0]!.args.some((value) => value.startsWith("WISP_BROWSER_PROXY="))).toBe(false);
  });

  it("removes a Wisp's browser with its container, and browsers of deleted Wisps", async () => {
    const { cli, manager } = await setup();
    cli.containers.set(manager.browserName("s1"), { running: true, spec: "x" });
    cli.containers.set(manager.browserName("gone"), { running: true, spec: "x" });

    await manager.reconcile(new Set(["s1"]));
    expect([...cli.containers.keys()]).toEqual([manager.browserName("s1")]);

    await manager.remove("s1");
    expect(cli.containers.size).toBe(0);
  });

  it("removes a browser that does not close when its input ends", async () => {
    const { cli, manager } = await setup();
    const browser = await manager.startBrowser({ storageId: "s1", localNetwork: true }, { onStdout: () => undefined });
    const stuck = { ...browser, end: () => undefined };
    cli.containers.set(manager.browserName("s1"), { running: true, spec: "x" });
    vi.useFakeTimers();

    const closing = manager.closeBrowser("s1", stuck);
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
    expect(cli.containers.has(manager.browserName("s1"))).toBe(false);
  });
});
