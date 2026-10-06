import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  describeSetup,
  normalizeOrigin,
  parseEnvFile,
  renderEnvFile,
  renderUnit,
  runSetup,
  setupPaths,
  type CommandResult,
  type SetupHost,
  type SetupOptions,
} from "../../server/setup.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const ok: CommandResult = { code: 0, stdout: "", stderr: "" };
const options: SetupOptions = { service: true, pair: true };

/** A machine that records what setup runs; `respond` decides what each command answers. */
async function machine(respond: (command: string, args: readonly string[]) => Partial<CommandResult> = () => ({})) {
  const home = await mkdtemp(path.join(os.tmpdir(), "wisp-setup-"));
  homes.push(home);
  const paths = setupPaths(home);
  const calls: string[] = [];
  const progress: string[] = [];
  let healthy = true;
  let active = false;
  const host: SetupHost = {
    home,
    user: "wisp",
    uid: 1000,
    platform: "linux",
    env: { PATH: "/usr/bin" },
    nodePath: "/usr/bin/node",
    version: "1.2.3",
    run: async (command, args, env) => {
      calls.push([command, ...args].join(" "));
      if (command === "npm") {
        // What `npm install --prefix` leaves behind.
        await mkdir(paths.packageDir, { recursive: true });
        await writeFile(path.join(paths.packageDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
        expect(env.PATH).toMatch(/^\/usr\/bin:/);
      }
      if (command === "systemctl" && args.includes("restart")) active = true;
      if (command === "systemctl" && args.includes("is-active")) return { ...ok, code: active ? 0 : 3 };
      return { ...ok, ...respond(command, args) };
    },
    isHealthy: async () => healthy,
    pairingCode: async () => "ABCDE-FGHJK",
    sleep: async () => undefined,
    progress: (message) => void progress.push(message),
  };
  return { home, paths, host, calls, progress, setHealthy: (value: boolean) => void (healthy = value) };
}

describe("runSetup", () => {
  it("installs the package, creates the key and files, and starts the service", async () => {
    const { host, paths, calls } = await machine();
    const result = await runSetup(options, host);

    expect(calls[0]).toBe(
      `npm install --prefix ${paths.installDir} --no-audit --no-fund --loglevel=error @gustmrg/wisp-server@1.2.3`,
    );
    expect(calls.filter((call) => call.startsWith("systemctl"))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable wisp",
      "systemctl --user is-active --quiet wisp",
      "systemctl --user restart wisp",
    ]);
    expect(result).toMatchObject({
      version: "1.2.3",
      keyCreated: true,
      service: "started",
      pairingCode: "ABCDE-FGHJK",
      port: 8787,
    });

    expect((await stat(paths.keyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.keyFile)).size).toBe(32);
    expect((await stat(paths.envFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.wispctl)).mode & 0o777).toBe(0o755);
    expect(await readFile(paths.wispctl, "utf8")).toContain(`exec /usr/bin/node ${paths.cliScript} "$@"`);
    const unit = await readFile(paths.unitFile, "utf8");
    expect(unit).toContain(`ExecStart=/usr/bin/node ${paths.mainScript}`);
    expect(unit).toContain(`EnvironmentFile=${paths.envFile}`);
    expect(parseEnvFile(await readFile(paths.envFile, "utf8"))).toEqual(
      new Map([
        ["WISP_DATA_DIR", paths.defaultDataDirectory],
        ["WISP_MASTER_KEY_FILE", paths.keyFile],
        ["WISP_PORT", "8787"],
      ]),
    );
  });

  it("is safe to run again: keeps the key, skips the install, and leaves a healthy service alone", async () => {
    const { host, paths, calls } = await machine();
    await runSetup(options, host);
    const key = await readFile(paths.keyFile);
    calls.length = 0;

    const result = await runSetup({ ...options, pair: false }, host);
    expect(await readFile(paths.keyFile)).toEqual(key);
    expect(calls.some((call) => call.startsWith("npm"))).toBe(false);
    expect(calls.some((call) => call.includes("restart"))).toBe(false);
    expect(result).toMatchObject({ keyCreated: false, service: "unchanged" });
    expect(result.pairingCode).toBeUndefined();
  });

  it("restarts the running service when a setting changes, and keeps the settings it does not manage", async () => {
    const { host, paths, calls } = await machine();
    await runSetup({ ...options, pair: false }, host);
    const env = await readFile(paths.envFile, "utf8");
    await writeFile(paths.envFile, `${env}WISP_HOST=127.0.0.1\n`);
    calls.length = 0;

    const result = await runSetup(
      { ...options, pair: false, publicOrigin: "https://pi.tail1234.ts.net/", port: 9000 },
      host,
    );
    expect(result).toMatchObject({ service: "restarted", port: 9000, publicOrigin: "https://pi.tail1234.ts.net" });
    const values = parseEnvFile(await readFile(paths.envFile, "utf8"));
    expect(values.get("WISP_PORT")).toBe("9000");
    expect(values.get("WISP_PUBLIC_ORIGIN")).toBe("https://pi.tail1234.ts.net");
    expect(values.get("WISP_HOST")).toBe("127.0.0.1");
  });

  it("refuses a master key other accounts can read, rather than replacing it", async () => {
    const { host, paths } = await machine();
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.keyFile, Buffer.alloc(32, 1), { mode: 0o644 });
    await expect(runSetup(options, host)).rejects.toThrow(/readable only by its owner/);
    expect((await readFile(paths.keyFile))[0]).toBe(1);
  });

  it("only writes files with --no-service and says how to start the server", async () => {
    const { host, calls, paths } = await machine();
    const result = await runSetup({ ...options, service: false }, host);
    expect(calls.filter((call) => /^(systemctl|loginctl)/.test(call))).toEqual([]);
    expect(result.service).toBe("skipped");
    expect(result.startCommand).toContain(paths.mainScript);
    await expect(stat(paths.unitFile)).rejects.toThrow();
  });

  it("warns when it cannot enable linger", async () => {
    const { host } = await machine((command, args) =>
      command === "loginctl" && args[0] === "enable-linger" ? { code: 1 } : {},
    );
    const result = await runSetup(options, host);
    expect(result.warnings.join(" ")).toContain("sudo loginctl enable-linger wisp");
  });

  it("explains why it stopped", async () => {
    await expect(runSetup(options, { ...(await machine()).host, platform: "darwin" })).rejects.toThrow(/--no-service/);
    await expect(runSetup({ ...options, port: 70_000 }, (await machine()).host)).rejects.toThrow(/port/);
    await expect(runSetup({ ...options, publicOrigin: "http://example.com" }, (await machine()).host)).rejects.toThrow(
      /https/,
    );

    const missing = await machine((command) =>
      command === "npm" ? { code: 1, stderr: "npm error code E404\nnpm error 404 Not Found" } : {},
    );
    await expect(
      runSetup(options, {
        ...missing.host,
        run: async (c) => (c === "npm" ? { code: 1, stdout: "", stderr: "npm error 404 Not Found" } : ok),
      }),
    ).rejects.toThrow(/is not published on npm/);

    const noBus = await machine((command) =>
      command === "systemctl" ? { code: 1, stderr: "Failed to connect to bus: No medium found" } : {},
    );
    await expect(runSetup(options, noBus.host)).rejects.toThrow(/systemd user session/);

    const down = await machine();
    down.setHealthy(false);
    await expect(runSetup(options, down.host)).rejects.toThrow(/journalctl --user -u wisp/);
  });

  it("gives systemctl the user's runtime directory when SSH did not", async () => {
    const seen: Array<string | undefined> = [];
    const { host } = await machine();
    const run = host.run;
    await runSetup(options, {
      ...host,
      run: async (command, args, env, timeout) => {
        if (command === "systemctl") seen.push(env.XDG_RUNTIME_DIR);
        return run(command, args, env, timeout);
      },
    });
    expect(new Set(seen)).toEqual(new Set(["/run/user/1000"]));
  });
});

describe("setup files", () => {
  it("renders and merges environment files", () => {
    const first = renderEnvFile(undefined, { WISP_PORT: "8787", WISP_DATA_DIR: "/home/a b/wisp" });
    expect(first).toContain('WISP_DATA_DIR="/home/a b/wisp"');
    expect(first).toContain("# WISP_PUBLIC_ORIGIN=");
    expect(parseEnvFile(first).get("WISP_DATA_DIR")).toBe("/home/a b/wisp");

    const merged = renderEnvFile("# mine\nWISP_PORT=1\nOTHER=x\n", {
      WISP_PORT: "2",
      WISP_PUBLIC_ORIGIN: "https://h.ts.net",
    });
    expect(merged).toBe("# mine\nWISP_PORT=2\nOTHER=x\nWISP_PUBLIC_ORIGIN=https://h.ts.net\n");
  });

  it("quotes paths in the unit", () => {
    const unit = renderUnit("/opt/my node/bin/node", "/home/a%b/main.js", "/home/a%b/server.env");
    expect(unit).toContain('ExecStart="/opt/my node/bin/node" "/home/a%%b/main.js"');
    expect(unit).toContain("EnvironmentFile=/home/a%%b/server.env");
  });

  it("accepts only an https origin", () => {
    expect(normalizeOrigin("https://pi.tail1234.ts.net")).toBe("https://pi.tail1234.ts.net");
    for (const bad of ["pi.tail1234.ts.net", "http://pi.ts.net", "https://pi.ts.net/app", "https://pi.ts.net/?a=1"]) {
      expect(() => normalizeOrigin(bad)).toThrow();
    }
  });

  it("describes what to do next", () => {
    const text = describeSetup({
      version: "1.2.3",
      installDir: "/i",
      keyFile: "/k",
      keyCreated: true,
      envFile: "/e",
      wispctl: "/w",
      dataDirectory: "/d",
      port: 8787,
      service: "started",
      pairingCode: "ABCDE-FGHJK",
      warnings: [],
    });
    expect(text).toContain("running on port 8787");
    expect(text).toContain("Back up /k");
    expect(text).toContain("ABCDE-FGHJK");
    expect(text).toContain("tailscale serve");
  });
});
