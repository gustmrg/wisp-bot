import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listSshConfigHosts, readAliases, splitDirective } from "../../electron/connections/ssh-config.js";

const fakeSsh = path.join(__dirname, "../fixtures/fake-ssh.cjs");
const directories: string[] = [];

afterEach(async () => {
  delete process.env.FAKE_SSH_LOG;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function home(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-ssh-config-"));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text);
  }
  return directory;
}

describe("ssh config hosts", () => {
  it("splits directives like OpenSSH", () => {
    expect(splitDirective("  Host a b  ")).toEqual(["Host", "a", "b"]);
    expect(splitDirective("Host=a")).toEqual(["Host", "a"]);
    expect(splitDirective('Include "with space/x" y # comment')).toEqual(["Include", "with space/x", "y"]);
    expect(splitDirective("# Host a")).toEqual([]);
    expect(splitDirective("")).toEqual([]);
  });

  it("lists concrete hosts in order, following Include, without wildcards or repeats", async () => {
    const directory = await home({
      ".ssh/config": [
        "Include config.d/*",
        "Host pi nas.test.invalid",
        "  User me",
        "Host *.corp !bastion other?",
        "Host pi",
        "Include ~/extra/ssh.conf",
        "Match host foo",
        "Host *",
      ].join("\n"),
      ".ssh/config.d/10-work": "host=work-box\n",
      ".ssh/config.d/20-loop": "Include config\nHost loop-box\n",
      ".ssh/config.d/.hidden": "Host hidden\n",
      "extra/ssh.conf": 'HOST "quoted-box"\n',
    });
    expect(await readAliases(path.join(directory, ".ssh/config"), directory)).toEqual([
      "work-box",
      "loop-box",
      "pi",
      "nas.test.invalid",
      "quoted-box",
    ]);
  });

  it("resolves each alias with ssh -G, never connecting", async () => {
    const directory = await home({ ".ssh/config": "Host plain port-2222 unresolvable\n" });
    const log = path.join(directory, "ssh.log");
    process.env.FAKE_SSH_LOG = log;
    expect(await listSshConfigHosts({ home: directory, sshPath: fakeSsh })).toEqual([
      { alias: "plain", hostname: "plain.test.invalid", user: "tester", port: 22 },
      { alias: "port-2222", hostname: "port-2222.test.invalid", user: "tester", port: 2222 },
      { alias: "unresolvable" },
    ]);
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.every((call) => call[0] === "-G" && call[1] === "--")).toBe(true);
  });

  it("lists nothing without a config, or without OpenSSH", async () => {
    expect(await listSshConfigHosts({ home: await home({}), sshPath: fakeSsh })).toEqual([]);
    const directory = await home({ ".ssh/config": "Host pi\n" });
    expect(await listSshConfigHosts({ home: directory, sshPath: path.join(directory, "missing-ssh") })).toEqual([
      { alias: "pi" },
    ]);
  });
});
