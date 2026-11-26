import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../../server/cli.js";
import {
  describeStatus,
  type DoctorResult,
  type OpsHost,
  type ServerConfigView,
  type ServerLogsResult,
  type ServerStatus,
} from "../../server/ops.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wisp-ops-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface MockCall {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

function createMockHost(home: string, overrides: Partial<OpsHost> = {}): { host: OpsHost; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const defaultStatus: ServerStatus = {
    serverId: "srv-123",
    bootId: "boot-456",
    version: "1.2.3",
    port: 8787,
    devices: 2,
    web: true,
    publicOrigin: "https://box.tailnet.ts.net",
    startedAt: "2026-11-26T10:00:00.000Z",
    uptimeSeconds: 3_725,
    workingWisps: 1,
    pendingApprovals: 0,
    unreadConversations: 2,
    activeEventStreams: 1,
    memoryRssBytes: 64 * 1024 * 1024,
  };
  const host: OpsHost = {
    home,
    user: "wispuser",
    uid: 1000,
    platform: "linux",
    env: {},
    run: async (command, args, env) => {
      calls.push({ command, args, env });
      if (command === "systemctl" && args[1] === "is-active") {
        return { code: 0, stdout: "active\n", stderr: "" };
      }
      if (command === "loginctl" && args[0] === "show-user") {
        return { code: 0, stdout: "Linger=yes\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    checkRuntime: async () => [
      { name: "sqlite", ok: true },
      { name: "pdf", ok: true },
    ],
    checkContainerRuntime: async () => ({ available: true, name: "docker", version: "27.3.1" }),
    freeSpace: async () => 10 * 1024 * 1024 * 1024,
    serverStatus: async () => defaultStatus,
    posixMode: async () => 0o700,
    ...overrides,
  };
  return { host, calls };
}

describe("wispctl doctor", () => {
  it("reports all passing checks in JSON and terminal mode", async () => {
    const home = await tempHome();
    const dataDir = path.join(home, ".local", "share", "wisp");
    const configDir = path.join(home, ".config", "wisp");
    const keyFile = path.join(configDir, "master.key");
    await mkdir(dataDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(keyFile, randomBytes(32));

    const { host, calls } = createMockHost(home, {
      posixMode: async (filePath) => (filePath === keyFile ? 0o600 : 0o700),
    });

    let jsonOut = "";
    await runCli(["doctor", "--json"], (text) => void (jsonOut += text), { opsHost: host });
    const parsed = JSON.parse(jsonOut) as DoctorResult;
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.every((check) => check.status === "ok")).toBe(true);
    expect(parsed.checks.map((check) => check.name)).toEqual([
      "sqlite",
      "pdf",
      "data-dir",
      "disk-space",
      "master-key",
      "container-runtime",
      "server",
      "systemd-service",
      "systemd-linger",
    ]);
    // Verify mocked host was used for systemctl and loginctl with XDG_RUNTIME_DIR populated.
    expect(calls.map((call) => call.command)).toEqual(["systemctl", "loginctl"]);
    expect(calls[0]!.env.XDG_RUNTIME_DIR).toBe("/run/user/1000");

    let terminalOut = "";
    await runCli(["doctor"], (text) => void (terminalOut += text), { opsHost: host, terminal: true });
    expect(terminalOut).toContain("Wisp server diagnostics:");
    expect(terminalOut).toContain("[OK]   sqlite:");
    expect(terminalOut).toContain("Docker 27.3.1 is available.");
    expect(terminalOut).toContain("Summary: all checks passed.");
  });

  it("reports warnings without failing when optional components are absent", async () => {
    const home = await tempHome();
    const { host } = createMockHost(home, {
      checkContainerRuntime: async () => ({
        available: false,
        message: "Install Docker or Podman on the server to run commands in containers.",
      }),
      freeSpace: async () => 512 * 1024 * 1024,
      serverStatus: async () => undefined,
      run: async (command, args) => {
        if (command === "systemctl" && args[1] === "is-active") {
          return { code: 3, stdout: "inactive\n", stderr: "" };
        }
        if (command === "loginctl") {
          return { code: 0, stdout: "Linger=no\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    let jsonOut = "";
    await runCli(["doctor", "--json"], (text) => void (jsonOut += text), { opsHost: host });
    const parsed = JSON.parse(jsonOut) as DoctorResult;
    expect(parsed.ok).toBe(true);
    const byName = new Map(parsed.checks.map((check) => [check.name, check]));
    expect(byName.get("data-dir")?.status).toBe("warn");
    expect(byName.get("disk-space")?.status).toBe("warn");
    expect(byName.get("master-key")?.status).toBe("warn");
    expect(byName.get("container-runtime")?.status).toBe("warn");
    expect(byName.get("server")?.status).toBe("warn");
    expect(byName.get("systemd-service")?.status).toBe("warn");
    expect(byName.get("systemd-linger")?.status).toBe("warn");
  });

  it("writes the diagnostic report and throws when any check fails", async () => {
    const home = await tempHome();
    const dataDir = path.join(home, ".local", "share", "wisp");
    const configDir = path.join(home, ".config", "wisp");
    const keyFile = path.join(configDir, "master.key");
    await mkdir(dataDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(keyFile, randomBytes(16)); // Invalid key size (must be 32)

    const { host } = createMockHost(home, {
      checkRuntime: async () => [
        { name: "sqlite", ok: true },
        { name: "pdf", ok: false, error: "canvas missing" },
      ],
      freeSpace: async () => 20 * 1024 * 1024,
      posixMode: async (filePath) => (filePath === dataDir ? 0o755 : 0o644),
    });

    let jsonOut = "";
    await expect(runCli(["doctor", "--json"], (text) => void (jsonOut += text), { opsHost: host })).rejects.toThrow(
      /4 failing checks/,
    );

    const parsed = JSON.parse(jsonOut) as DoctorResult;
    expect(parsed.ok).toBe(false);
    const byName = new Map(parsed.checks.map((check) => [check.name, check]));
    expect(byName.get("pdf")?.status).toBe("fail");
    expect(byName.get("data-dir")?.status).toBe("fail");
    expect(byName.get("disk-space")?.status).toBe("fail");
    expect(byName.get("master-key")?.status).toBe("fail");
  });

  it("skips systemd checks on non-Linux hosts", async () => {
    const home = await tempHome();
    const { host, calls } = createMockHost(home, { platform: "darwin" });

    let jsonOut = "";
    await runCli(["doctor", "--json"], (text) => void (jsonOut += text), { opsHost: host });
    const parsed = JSON.parse(jsonOut) as DoctorResult;
    expect(parsed.checks.some((check) => check.name.startsWith("systemd"))).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("wispctl logs", () => {
  it("reads the latest lines across rotated log files in chronological order", async () => {
    const home = await tempHome();
    const dataDir = path.join(home, "data");
    const logsDir = path.join(dataDir, "backend", "logs");
    await mkdir(logsDir, { recursive: true });
    const rotated = path.join(logsDir, "backend.log.1");
    const active = path.join(logsDir, "backend.log");
    await writeFile(rotated, ["line-1", "line-2", "line-3"].join("\n") + "\n");
    await writeFile(active, ["line-4", "line-5"].join("\n") + "\n");
    await utimes(rotated, new Date("2026-11-26T09:00:00Z"), new Date("2026-11-26T09:00:00Z"));
    await utimes(active, new Date("2026-11-26T10:00:00Z"), new Date("2026-11-26T10:00:00Z"));

    const { host } = createMockHost(home);
    let plainOut = "";
    await runCli(["logs", "--data-dir", dataDir, "--lines", "4"], (text) => void (plainOut += text), {
      opsHost: host,
    });
    expect(plainOut).toBe("line-2\nline-3\nline-4\nline-5\n");

    let jsonOut = "";
    await runCli(["logs", "--data-dir", dataDir, "--lines", "2", "--json"], (text) => void (jsonOut += text), {
      opsHost: host,
    });
    const parsed = JSON.parse(jsonOut) as ServerLogsResult;
    expect(parsed).toEqual({
      directory: logsDir,
      files: ["backend.log"],
      lines: ["line-4", "line-5"],
    });
  });

  it("handles missing log directories and rejects invalid --lines values", async () => {
    const home = await tempHome();
    const dataDir = path.join(home, "empty-data");
    const { host } = createMockHost(home);

    let textOut = "";
    await runCli(["logs", "--data-dir", dataDir], (text) => void (textOut += text), { opsHost: host });
    expect(textOut).toContain("No log entries found");

    await expect(
      runCli(["logs", "--data-dir", dataDir, "--lines", "0"], () => undefined, { opsHost: host }),
    ).rejects.toThrow(/--lines must be a whole number between 1 and 1000/);
    await expect(
      runCli(["logs", "--data-dir", dataDir, "--lines", "1001"], () => undefined, { opsHost: host }),
    ).rejects.toThrow(/--lines must be a whole number between 1 and 1000/);
  });
});

describe("wispctl config", () => {
  it("reads server.env and prints resolved paths in JSON and terminal mode", async () => {
    const home = await tempHome();
    const configDir = path.join(home, ".config", "wisp");
    const customData = path.join(home, "custom-data");
    const customKey = path.join(configDir, "custom.key");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "server.env"),
      [
        "# Wisp server settings",
        `WISP_DATA_DIR=${customData}`,
        `WISP_MASTER_KEY_FILE=${customKey}`,
        "WISP_PORT=9090",
        "WISP_WEB=1",
        "WISP_PUBLIC_ORIGIN=https://wisp.tailnet.ts.net",
      ].join("\n") + "\n",
    );

    const { host } = createMockHost(home);
    let jsonOut = "";
    await runCli(["config", "--json"], (text) => void (jsonOut += text), { opsHost: host });
    const parsed = JSON.parse(jsonOut) as ServerConfigView;
    expect(parsed).toMatchObject({
      envFile: path.join(configDir, "server.env"),
      envFileExists: true,
      dataDirectory: customData,
      masterKeyFile: customKey,
      host: "127.0.0.1",
      port: 9090,
      allowExternalBind: false,
      web: true,
      publicOrigin: "https://wisp.tailnet.ts.net",
    });

    let terminalOut = "";
    await runCli(["config"], (text) => void (terminalOut += text), { opsHost: host, terminal: true });
    expect(terminalOut).toContain(`Config file: ${path.join(configDir, "server.env")}`);
    expect(terminalOut).toContain(`Data directory: ${customData}`);
    expect(terminalOut).toContain("Listen address: 127.0.0.1:9090");
    expect(terminalOut).toContain("Browser app: enabled");
    expect(terminalOut).toContain("Public origin: https://wisp.tailnet.ts.net");
  });

  it("shows defaults when server.env does not exist", async () => {
    const home = await tempHome();
    const { host } = createMockHost(home);
    let jsonOut = "";
    await runCli(["config", "--json"], (text) => void (jsonOut += text), { opsHost: host });
    const parsed = JSON.parse(jsonOut) as ServerConfigView;
    expect(parsed.envFileExists).toBe(false);
    expect(parsed.port).toBe(8787);
    expect(parsed.web).toBe(false);
  });
});

describe("wispctl start / stop / restart", () => {
  it("delegates to systemctl --user on Linux with XDG_RUNTIME_DIR", async () => {
    const home = await tempHome();
    const { host, calls } = createMockHost(home);

    for (const [action, expected] of [
      ["start", "Started wisp service.\n"],
      ["stop", "Stopped wisp service.\n"],
      ["restart", "Restarted wisp service.\n"],
    ] as const) {
      let out = "";
      await runCli([action], (text) => void (out += text), { opsHost: host, terminal: true });
      expect(out).toBe(expected);
    }
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["systemctl", "--user", "start", "wisp"],
      ["systemctl", "--user", "stop", "wisp"],
      ["systemctl", "--user", "restart", "wisp"],
    ]);

    let jsonOut = "";
    await runCli(["restart", "--json"], (text) => void (jsonOut += text), { opsHost: host });
    expect(JSON.parse(jsonOut)).toEqual({ service: "wisp", action: "restart", ok: true });
  });

  it("reports clear errors when systemd is unavailable, unit is missing, or platform is not Linux", async () => {
    const home = await tempHome();

    const nonLinux = createMockHost(home, { platform: "darwin" });
    await expect(runCli(["start"], () => undefined, { opsHost: nonLinux.host })).rejects.toThrow(
      /requires Linux with systemd/,
    );

    const noSystemd = createMockHost(home, {
      run: async () => ({ code: 127, stdout: "", stderr: "systemctl: command not found" }),
    });
    await expect(runCli(["restart"], () => undefined, { opsHost: noSystemd.host })).rejects.toThrow(
      /systemd is not available/,
    );

    const noUnit = createMockHost(home, {
      run: async () => ({ code: 5, stdout: "", stderr: "Failed to start wisp.service: Unit wisp.service not found." }),
    });
    await expect(runCli(["start"], () => undefined, { opsHost: noUnit.host })).rejects.toThrow(
      /service is not installed/,
    );

    const noBus = createMockHost(home, {
      run: async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus: No such file or directory" }),
    });
    await expect(runCli(["stop"], () => undefined, { opsHost: noBus.host })).rejects.toThrow(
      /systemd user session is not reachable/,
    );
  });
});

describe("describeStatus", () => {
  it("formats operational telemetry clearly for a terminal", () => {
    const text = describeStatus({
      serverId: "srv-123",
      bootId: "boot-456",
      version: "1.2.3",
      port: 8787,
      exposedPort: 8788,
      devices: 2,
      web: true,
      publicOrigin: "https://box.tailnet.ts.net",
      startedAt: "2026-11-26T10:00:00.000Z",
      uptimeSeconds: 90_061,
      workingWisps: 1,
      pendingApprovals: 2,
      unreadConversations: 3,
      activeEventStreams: 4,
      memoryRssBytes: 64 * 1024 * 1024,
    });
    expect(text).toContain("Wisp server 1.2.3 (running)");
    expect(text).toContain("Port: 8787 (exposed: 8788)");
    expect(text).toContain("Uptime: 1d 1h 1m (since 2026-11-26T10:00:00.000Z)");
    expect(text).toContain("Paired devices: 2");
    expect(text).toContain("Working Wisps: 1");
    expect(text).toContain("Pending approvals: 2");
    expect(text).toContain("Unread conversations: 3");
    expect(text).toContain("Active event streams: 4");
    expect(text).toContain("Memory (RSS): 64.0 MiB");
    expect(text).toContain("Browser app: enabled");
    expect(text).toContain("Public origin: https://box.tailnet.ts.net");
  });
});
