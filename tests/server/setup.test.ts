import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SERVER_ARCHIVE_MANIFEST } from "../../shared/server-package.js";
import { readUpdateRecord } from "../../server/update-record.js";
import { readJournal } from "../../server/update-transaction.js";
import {
  describeSetup,
  findServerArchive,
  normalizeOrigin,
  parseEnvFile,
  probeAddress,
  renderEnvFile,
  renderUnit,
  runSetup,
  setupPaths,
  type CommandResult,
  type ServerArchive,
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
  let npmVersion = "1.2.3";
  let answers: string | undefined;
  /** What the service runs since its last restart: the archive `current` points at, or the npm package. */
  let running: string | undefined;
  let runtimeOk = true;
  /** A server started by hand on the same data directory, outside the service. */
  let foreignServer: string | undefined;
  let foreign = false;
  let listening = 0;
  const probed: string[] = [];
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
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const packageDir = path.join(prefix, path.relative(paths.installDir, paths.packageDir));
        await mkdir(path.join(packageDir, "server"), { recursive: true });
        await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ version: npmVersion }));
        await writeFile(path.join(packageDir, "server/main.js"), "");
        // The directory of the running Node.js comes first.
        expect(env.PATH).toMatch(/\/bin:\/usr\/bin$/);
      }
      if (command === "systemctl" && args.includes("stop")) active = false;
      if (command === "systemctl" && (args.includes("restart") || args.includes("start"))) {
        active = true;
        const link = await readlink(paths.current).catch(() => undefined);
        running = link
          ? path.basename(link)
          : (JSON.parse(await readFile(path.join(paths.packageDir, "package.json"), "utf8")) as { version: string })
              .version;
        listening = Number(parseEnvFile(await readFile(paths.envFile, "utf8")).get("WISP_PORT"));
      }
      if (command === "systemctl" && args.includes("is-active")) return { ...ok, code: active ? 0 : 3 };
      return { ...ok, ...respond(command, args) };
    },
    isHealthy: async (address) => {
      probed.push(address);
      return healthy && active;
    },
    isPortInUse: async (address, port) => {
      probed.push(address);
      return foreign || (active && port === listening);
    },
    pairingCode: async () => "ABCDE-FGHJK",
    serverVersion: async () => (active ? (answers ?? running) : foreignServer),
    checkRuntime: async () => [
      { name: "sqlite", ok: true },
      runtimeOk
        ? { name: "pdf", ok: true }
        : { name: "pdf", ok: false, error: "canvas.node: cannot open shared object" },
    ],
    pid: 4242,
    freeSpace: async () => 10 * 1024 ** 3,
    // This setup, and another one that runs.
    isProcessAlive: (pid) => pid === 4242 || pid === 5000,
    now: () => new Date("2026-11-09T12:00:00.000Z"),
    sleep: async () => undefined,
    progress: (message) => void progress.push(message),
  };
  return {
    home,
    paths,
    host,
    calls,
    progress,
    probed,
    setHealthy: (value: boolean) => void (healthy = value),
    setNpmVersion: (value: string) => void (npmVersion = value),
    setAnswers: (value: string | undefined) => void (answers = value),
    setRuntimeOk: (value: boolean) => void (runtimeOk = value),
    setForeignServer: (value: string | undefined) => void (foreignServer = value),
    setForeign: (value: boolean) => void (foreign = value),
  };
}

describe("runSetup", () => {
  it("installs the package, creates the key and files, and starts the service", async () => {
    const { host, paths, calls } = await machine();
    const result = await runSetup(options, host);

    expect(calls[0]).toMatch(
      new RegExp(
        `^npm install --prefix ${paths.installDir}/\\.npm-staging-\\w+ --no-audit --no-fund --loglevel=error @gustmrg/wisp-server@1\\.2\\.3$`,
      ),
    );
    expect(await readdir(paths.installDir)).toEqual(["node_modules"]);
    expect(calls.filter((call) => call.startsWith("systemctl"))).toEqual([
      "systemctl --user is-active --quiet wisp",
      "systemctl --user daemon-reload",
      "systemctl --user enable wisp",
      "systemctl --user restart wisp",
      "systemctl --user is-active --quiet wisp",
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
        ["WISP_WEB", "0"],
      ]),
    );
    expect(result.web).toBe(false);
  });

  it("serves the browser app when asked to, and keeps that setting on later runs", async () => {
    const { host, paths } = await machine();
    expect(await runSetup({ ...options, pair: false, web: true }, host)).toMatchObject({ web: true });
    expect(parseEnvFile(await readFile(paths.envFile, "utf8")).get("WISP_WEB")).toBe("1");

    expect(await runSetup({ ...options, pair: false }, host)).toMatchObject({ web: true });
    const result = await runSetup({ ...options, pair: false, web: false }, host);
    expect(result).toMatchObject({ web: false, service: "restarted" });
    expect(parseEnvFile(await readFile(paths.envFile, "utf8")).get("WISP_WEB")).toBe("0");
  });

  it("keeps serving the browser app on a server set up before the setting existed", async () => {
    const { host, paths } = await machine();
    await runSetup({ ...options, pair: false }, host);
    const env = await readFile(paths.envFile, "utf8");
    await writeFile(paths.envFile, env.replace("WISP_WEB=0\n", ""));

    expect(await runSetup({ ...options, pair: false }, host)).toMatchObject({ web: true });
    expect(parseEnvFile(await readFile(paths.envFile, "utf8")).get("WISP_WEB")).toBe("1");
  });

  it("is safe to run again: keeps the key, skips the install, and leaves a healthy service alone", async () => {
    const { host, paths, calls } = await machine();
    await runSetup(options, host);
    const key = await readFile(paths.keyFile);
    calls.length = 0;

    const { host: quiet, progress } = await machine();
    const result = await runSetup({ ...options, pair: false }, { ...host, progress: quiet.progress });
    expect(progress).toContain("The service is already running.");
    expect(progress).not.toContain("Starting the service…");
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
    // A server that never ran is not left enabled to fail on every boot.
    expect(down.calls.at(-1)).toBe("systemctl --user disable --now wisp");
  });

  it("reinstalls a package an interrupted install left incomplete", async () => {
    const { host, paths, calls } = await machine();
    await runSetup(options, host);
    await writeFile(
      path.join(paths.packageDir, "package.json"),
      JSON.stringify({ version: "1.2.3", dependencies: { "@scope/dep": "1.0.0" } }),
    );
    calls.length = 0;
    await runSetup({ ...options, pair: false }, host);
    expect(calls.filter((call) => call.startsWith("npm"))).toHaveLength(1);

    // npm hoists dependencies to the top of the install directory.
    await writeFile(
      path.join(paths.packageDir, "package.json"),
      JSON.stringify({ version: "1.2.3", dependencies: { "@scope/dep": "1.0.0" } }),
    );
    await mkdir(path.join(paths.installDir, "node_modules/@scope/dep"), { recursive: true });
    await writeFile(path.join(paths.installDir, "node_modules/@scope/dep/package.json"), "{}");
    calls.length = 0;
    await runSetup({ ...options, pair: false }, host);
    expect(calls.some((call) => call.startsWith("npm"))).toBe(false);

    await rm(paths.mainScript);
    calls.length = 0;
    await runSetup({ ...options, pair: false }, host);
    expect(calls.filter((call) => call.startsWith("npm"))).toHaveLength(1);
  });

  it("stops before starting the service when cancelled", async () => {
    const cancel = new AbortController();
    const { host, calls } = await machine();
    const run = host.run;
    await expect(
      runSetup(
        { ...options, signal: cancel.signal },
        {
          ...host,
          run: async (command, args, env, timeout, signal) => {
            const result = await run(command, args, env, timeout, signal);
            if (command === "npm") cancel.abort();
            return result;
          },
        },
      ),
    ).rejects.toThrow(/cancelled/);
    expect(calls.some((call) => call.startsWith("systemctl"))).toBe(false);
  });

  it("refuses a port another program uses, before it enables anything", async () => {
    const { host, calls, paths, setForeign } = await machine();
    setForeign(true);
    await expect(runSetup(options, host)).rejects.toThrow(/Another program already uses port 8787/);
    expect(calls.filter((call) => call.startsWith("systemctl"))).toEqual(["systemctl --user is-active --quiet wisp"]);
    await expect(stat(paths.unitFile)).rejects.toThrow();
  });

  it("keeps its own port when it runs already, but checks a new one", async () => {
    const { host, calls, setForeign } = await machine();
    await runSetup({ ...options, pair: false }, host);
    calls.length = 0;
    // The running Wisp answers on its own port.
    await expect(runSetup({ ...options, pair: false }, host)).resolves.toMatchObject({ service: "unchanged" });

    setForeign(true);
    await expect(runSetup({ ...options, pair: false, port: 9000 }, host)).rejects.toThrow(/uses port 9000/);
    // The server that was running is not disabled.
    expect(calls.some((call) => call.includes("disable"))).toBe(false);
  });

  it("fails when the service stops right after it answered", async () => {
    const { host } = await machine();
    let started = false;
    await expect(
      runSetup(options, {
        ...host,
        run: async (command, args, env) => {
          if (command === "npm") return host.run(command, args, env);
          if (args.includes("restart")) started = true;
          // Crash-looping: never active for long.
          return { ...ok, code: args.includes("is-active") ? 3 : 0 };
        },
        isHealthy: async () => started,
        isPortInUse: async () => false,
      }),
    ).rejects.toThrow(/stopped right after it started/);
  });

  it("checks the server where WISP_HOST says it listens", async () => {
    const { host, paths, probed } = await machine();
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.envFile, "WISP_HOST=100.64.0.7\n", { mode: 0o600 });
    await runSetup(options, host);
    expect(new Set(probed)).toEqual(new Set(["100.64.0.7"]));
    expect([undefined, "0.0.0.0", "::", "[::1]"].map(probeAddress)).toEqual(["127.0.0.1", "127.0.0.1", "::1", "::1"]);
  });

  it("warns that a Node.js under the home ties the service to that version", async () => {
    const { host } = await machine();
    const nodePath = path.join(host.home, ".nvm/versions/node/v22.19.0/bin/node");
    const result = await runSetup(options, { ...host, nodePath });
    expect(result.warnings.join(" ")).toContain(`The server runs ${nodePath}`);
    expect((await runSetup(options, host)).warnings.join(" ")).not.toContain("The server runs");
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
      web: true,
      service: "started",
      pairingCode: "ABCDE-FGHJK",
      warnings: [],
    });
    expect(text).toContain("running on port 8787");
    expect(text).toContain("Back up /k");
    expect(text).toContain("ABCDE-FGHJK");
    expect(text).toContain("tailscale serve");
  });

  it("points to --web when the server does not serve the browser app", () => {
    const text = describeSetup({
      version: "1.2.3",
      installDir: "/i",
      keyFile: "/k",
      keyCreated: false,
      envFile: "/e",
      wispctl: "/w",
      dataDirectory: "/d",
      port: 8787,
      web: false,
      service: "unchanged",
      warnings: [],
    });
    expect(text).toContain("wispctl setup --web");
    expect(text).not.toContain("tailscale serve");
  });
});

/** An extracted server archive with the files setup looks at. */
async function archiveOf(version: string): Promise<ServerArchive> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-archive-"));
  homes.push(root);
  await mkdir(path.join(root, "app/server"), { recursive: true });
  await writeFile(path.join(root, "app/server/main.js"), "");
  await mkdir(path.join(root, "runtime"));
  await writeFile(path.join(root, "runtime/node"), "", { mode: 0o755 });
  const manifest = { version, platform: "linux", arch: "x64", node: "22.23.4" } as const;
  await writeFile(path.join(root, SERVER_ARCHIVE_MANIFEST), JSON.stringify(manifest));
  return { root, manifest };
}

describe("runSetup from a server archive", () => {
  it("installs the archive under versions/ and runs the service with its own Node.js", async () => {
    const { host, paths, calls } = await machine();
    const archive = await archiveOf("1.3.0");
    // Even a Node.js under the home: the archive's own runs the server.
    const result = await runSetup(options, { ...host, archive, nodePath: path.join(host.home, ".nvm/node") });

    expect(result).toMatchObject({ version: "1.3.0", service: "started" });
    expect(calls.some((call) => call.startsWith("npm"))).toBe(false);
    expect(await readlink(paths.current)).toBe("versions/1.3.0");
    expect(await readFile(path.join(paths.versionsDir, "1.3.0/.install-complete"), "utf8")).toBe("1.3.0");
    expect(await readFile(paths.currentMainScript, "utf8")).toBe("");
    expect(await readFile(paths.unitFile, "utf8")).toContain(
      `ExecStart=${paths.currentNode} ${paths.currentMainScript}`,
    );
    expect(await readFile(paths.wispctl, "utf8")).toContain(`exec ${paths.currentWispctl} "$@"`);
    expect(result.warnings.join(" ")).not.toContain("Node.js version");
  });

  it("keeps an installed version, and switches and restarts for a new one", async () => {
    const { host, paths } = await machine();
    await runSetup({ ...options, pair: false }, { ...host, archive: await archiveOf("1.3.0") });

    const again = await runSetup({ ...options, pair: false }, { ...host, archive: await archiveOf("1.3.0") });
    expect(again.service).toBe("unchanged");

    const update = await runSetup({ ...options, pair: false }, { ...host, archive: await archiveOf("1.4.0") });
    expect(update).toMatchObject({ version: "1.4.0", service: "restarted" });
    expect(await readlink(paths.current)).toBe("versions/1.4.0");
    expect((await readdir(paths.versionsDir)).sort()).toEqual(["1.3.0", "1.4.0"]);
  });

  it("leaves no partial version behind when cancelled", async () => {
    const { host, paths } = await machine();
    const cancel = new AbortController();
    // Cancelled while the archive is copied.
    const progress = (message: string) => void (message.startsWith("Installing") && cancel.abort());
    await expect(
      runSetup({ ...options, signal: cancel.signal }, { ...host, progress, archive: await archiveOf("1.3.0") }),
    ).rejects.toThrow("The setup was cancelled.");
    expect(await readdir(paths.versionsDir)).toEqual([]);
    await expect(readlink(paths.current)).rejects.toThrow();
  });

  it("moves a server installed from npm to the archive, keeping its key, settings and data", async () => {
    const { host, paths } = await machine();
    await runSetup({ ...options, pair: false, port: 9000, web: true }, host);
    const key = await readFile(paths.keyFile);
    const env = await readFile(paths.envFile, "utf8");

    const result = await runSetup({ ...options, pair: false }, { ...host, archive: await archiveOf("1.3.0") });
    expect(result).toMatchObject({ version: "1.3.0", service: "restarted", port: 9000, web: true });
    expect((await readdir(paths.installDir)).sort()).toEqual(["current", "versions"]);
    expect(await readFile(paths.keyFile)).toEqual(key);
    expect(await readFile(paths.envFile, "utf8")).toBe(env);
    expect(await readFile(paths.unitFile, "utf8")).toContain(
      `ExecStart=${paths.currentNode} ${paths.currentMainScript}`,
    );
  });

  it("keeps the running version and the one before it", async () => {
    const { host, paths } = await machine();
    for (const version of ["1.3.0", "1.4.0", "1.5.0"]) {
      await runSetup({ ...options, pair: false }, { ...host, archive: await archiveOf(version) });
    }
    expect((await readdir(paths.versionsDir)).sort()).toEqual(["1.4.0", "1.5.0"]);
  });

  it("refuses to start the service while another server uses the data directory", async () => {
    const { host, calls, setForeignServer } = await machine();
    setForeignServer("1.2.0");
    await expect(runSetup(options, { ...host, archive: await archiveOf("1.3.0") })).rejects.toThrow(
      /A Wisp server \(1\.2\.0\) already runs on .* without the service/,
    );
    expect(calls.some((call) => call.includes("enable") || call.includes("restart"))).toBe(false);
  });

  it("refuses to install an npm package instead", async () => {
    const { host } = await machine();
    await expect(
      runSetup(
        { ...options, packageSpec: "@gustmrg/wisp-server@1.0.0" },
        { ...host, archive: await archiveOf("1.3.0") },
      ),
    ).rejects.toThrow(/--package installs the npm package/);
  });

  it("finds the archive the running code belongs to", async () => {
    const archive = await archiveOf("1.3.0");
    expect(findServerArchive(path.join(archive.root, "app/server"))).toEqual(archive);
    await writeFile(path.join(archive.root, SERVER_ARCHIVE_MANIFEST), JSON.stringify({ version: "1.3.0; rm -rf /" }));
    expect(findServerArchive(path.join(archive.root, "app/server"))).toBeUndefined();
    expect(findServerArchive(path.join(os.tmpdir(), "nowhere/app/server"))).toBeUndefined();
  });
});

const UPDATE_ID = "0b7f8a6e-2c1d-4e5f-9a8b-7c6d5e4f3a2b";

describe("the update record", () => {
  const recordOf = async (paths: ReturnType<typeof setupPaths>) =>
    JSON.parse(await readFile(paths.updateRecord, "utf8")) as Record<string, unknown>;

  it("records each run and the version the server answered with", async () => {
    const { host, paths, setNpmVersion } = await machine();
    const result = await runSetup({ ...options, updateId: UPDATE_ID }, host);
    expect(result).toMatchObject({ updateId: UPDATE_ID, runningVersion: "1.2.3" });
    expect(await recordOf(paths)).toEqual({
      id: UPDATE_ID,
      targetVersion: "1.2.3",
      runningVersion: "1.2.3",
      state: "completed",
      pid: 4242,
      startedAt: "2026-11-09T12:00:00.000Z",
      updatedAt: "2026-11-09T12:00:00.000Z",
    });
    expect((await stat(paths.updateRecord)).mode & 0o777).toBe(0o600);

    setNpmVersion("1.3.0");
    const update = await runSetup({ ...options, pair: false }, { ...host, version: "1.3.0" });
    expect(update.updateId).not.toBe(UPDATE_ID);
    expect(await recordOf(paths)).toMatchObject({
      fromVersion: "1.2.3",
      targetVersion: "1.3.0",
      runningVersion: "1.3.0",
      state: "completed",
    });
  });

  it("leaves the running server alone when the new version cannot run on the machine", async () => {
    const { host, paths, calls, setRuntimeOk } = await machine();
    await runSetup({ ...options, pair: false }, host);
    calls.length = 0;
    setRuntimeOk(false);

    await expect(runSetup({ ...options, updateId: UPDATE_ID }, { ...host, version: "1.3.0" })).rejects.toThrow(
      "Wisp server 1.3.0 cannot run on this machine: the pdf check failed: canvas.node: cannot open shared object",
    );
    expect(calls).toEqual([]);
    expect(await recordOf(paths)).toMatchObject({
      id: UPDATE_ID,
      fromVersion: "1.2.3",
      targetVersion: "1.3.0",
      state: "failed",
      error: expect.stringContaining("cannot run on this machine"),
    });
  });

  it("keeps the installed package when npm fails", async () => {
    const { host, paths } = await machine();
    await runSetup({ ...options, pair: false }, host);
    const failing: SetupHost = {
      ...host,
      version: "1.3.0",
      run: async (command, args, env) =>
        command === "npm" ? { code: 1, stdout: "", stderr: "npm error code E404" } : host.run(command, args, env),
    };
    await expect(runSetup(options, failing)).rejects.toThrow(/is not published on npm/);
    expect(JSON.parse(await readFile(path.join(paths.packageDir, "package.json"), "utf8")).version).toBe("1.2.3");
    expect(await readdir(paths.installDir)).toEqual(["node_modules"]);
  });

  it("fails when the server answers at another version than the one installed", async () => {
    const { host, paths, setAnswers } = await machine();
    setAnswers("1.1.0");
    await expect(runSetup(options, host)).rejects.toThrow(/answers as version 1\.1\.0 instead of 1\.2\.3/);
    expect(await recordOf(paths)).toMatchObject({ state: "failed" });
  });

  it("refuses to run beside another setup, and reads one whose process ended as interrupted", async () => {
    const { host, paths } = await machine();
    const unfinished = (pid: number) => ({
      id: UPDATE_ID,
      targetVersion: "1.2.3",
      state: "preparing",
      pid,
      startedAt: "2026-11-09T11:00:00.000Z",
      updatedAt: "2026-11-09T11:00:00.000Z",
    });
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.updateRecord, JSON.stringify(unfinished(5000)));
    await expect(runSetup(options, host)).rejects.toThrow("Another Wisp server setup is running (process 5000).");

    await writeFile(paths.updateRecord, JSON.stringify(unfinished(31337)));
    expect(await readUpdateRecord(paths.updateRecord, host.isProcessAlive)).toMatchObject({
      id: UPDATE_ID,
      state: "interrupted",
      error: "The setup stopped before it finished.",
    });
    await expect(runSetup(options, host)).resolves.toMatchObject({ service: "started" });
  });

  it("refuses an update ID that is not a UUID, since it reaches a remote shell", async () => {
    const { host } = await machine();
    await expect(runSetup({ ...options, updateId: "x; rm -rf ~" }, host)).rejects.toThrow("must be a UUID");
  });
});

describe("updating from one archive to another, with a rollback", () => {
  /** A machine whose service ran 1.3.0 from its archive, with data in its data directory. */
  async function runningArchive(respond?: Parameters<typeof machine>[0]) {
    const running = await machine(respond);
    await runSetup({ ...options, pair: false }, { ...running.host, archive: await archiveOf("1.3.0") });
    const data = running.paths.defaultDataDirectory;
    await mkdir(path.join(data, "backend"), { recursive: true });
    await writeFile(path.join(data, "backend/conversations.sqlite"), "data of 1.3.0");
    running.calls.length = 0;
    return { ...running, data };
  }
  const conversations = (data: string) => readFile(path.join(data, "backend/conversations.sqlite"), "utf8");

  it("stops the server, has the new version open the data, then commits and starts it", async () => {
    const { host, paths, calls, data } = await runningArchive();
    const result = await runSetup(
      { ...options, pair: false, updateId: UPDATE_ID },
      { ...host, archive: await archiveOf("1.4.0") },
    );
    expect(result).toMatchObject({ version: "1.4.0", service: "restarted", runningVersion: "1.4.0" });
    const target = path.join(paths.versionsDir, "1.4.0");
    const stop = calls.indexOf("systemctl --user stop wisp");
    const trial = calls.indexOf(
      `${target}/runtime/node ${target}/app/server/cli.js prepare-data --data-dir ${data} --key-file ${paths.keyFile}`,
    );
    const start = calls.indexOf("systemctl --user restart wisp");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(trial).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(trial);
    expect(await readlink(paths.current)).toBe("versions/1.4.0");
    expect(await readJournal(data)).toBeUndefined();
    expect(await readdir(data)).not.toContain("update-snapshots");
  });

  it("restores the data and the previous version when the new one cannot open the data", async () => {
    let data = "";
    const { host, paths, calls, ...running } = await runningArchive((command, args) => {
      if (!args.includes("prepare-data")) return {};
      // Halfway through its upgrade, the new version fails.
      writeFileSync(path.join(data, "backend/conversations.sqlite"), "half upgraded by 1.4.0");
      return { code: 1, stderr: "Error: no such column: wisp_id\n" };
    });
    data = running.data;
    await expect(
      runSetup({ ...options, pair: false, updateId: UPDATE_ID }, { ...host, archive: await archiveOf("1.4.0") }),
    ).rejects.toThrow(
      "Wisp server 1.4.0 could not open the data, so 1.3.0 and its data were restored: Error: no such column: wisp_id",
    );
    expect(await conversations(data)).toBe("data of 1.3.0");
    expect(await readlink(paths.current)).toBe("versions/1.3.0");
    expect(calls).toContain("systemctl --user start wisp");
    expect(calls.some((call) => call.includes("restart"))).toBe(false);
    expect(await readJournal(data)).toBeUndefined();
    expect(JSON.parse(await readFile(paths.updateRecord, "utf8"))).toMatchObject({
      id: UPDATE_ID,
      state: "rolled-back",
      fromVersion: "1.3.0",
      targetVersion: "1.4.0",
    });
  });

  it("stops nothing when there is no room for a copy of the data", async () => {
    const { host, paths, calls } = await runningArchive();
    await expect(
      runSetup(
        { ...options, pair: false },
        { ...host, freeSpace: async () => 1024, archive: await archiveOf("1.4.0") },
      ),
    ).rejects.toThrow(/Updating needs \d+ MB free in .* to keep a copy of the data, and 1 MB are free/);
    expect(calls.some((call) => call.includes("stop"))).toBe(false);
    expect(await readlink(paths.current)).toBe("versions/1.3.0");
  });
});
