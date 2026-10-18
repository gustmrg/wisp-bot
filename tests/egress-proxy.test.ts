import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EGRESS_PROXY_SCRIPT } from "../backend/egress-proxy.js";

let directory: string;
let target: http.Server;
let targetPort: number;
const proxies: ChildProcess[] = [];

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "wisp-egress-"));
  await writeFile(path.join(directory, "proxy.cjs"), EGRESS_PROXY_SCRIPT);
  target = http.createServer((request, response) => {
    if (request.url?.startsWith("/old/")) {
      response.writeHead(301, { location: `http://127.0.0.1:${targetPort}/new/${request.url.slice(5)}` }).end();
      return;
    }
    let bytes = 0;
    request.on("data", (chunk: Buffer) => (bytes += chunk.length));
    request.on("end", () =>
      response.end(JSON.stringify({ method: request.method, path: request.url, headers: request.headers, bytes })),
    );
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetPort = (target.address() as net.AddressInfo).port;
});

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  await new Promise((resolve) => target.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

interface Proxy {
  port: number;
  gitPort: number;
  /** Sets or, with null, forgets the git gateway's token for an address, as the server does. */
  control: (input: string) => Promise<number | null>;
}

/**
 * Starts the real proxy script with Node; `allow` lets the test reach its own
 * loopback server, and the git gateway sends to `gitUpstream` instead of github.com.
 */
async function startProxy(options: { allow?: string; gitUpstream?: string } = {}): Promise<Proxy> {
  const controlName = `wisp-egress-test-${process.pid}-${proxies.length}`;
  const env = {
    PATH: process.env.PATH,
    WISP_EGRESS_PORT: "0",
    WISP_GIT_PORT: "0",
    WISP_EGRESS_CONTROL: controlName,
    ...(options.allow ? { WISP_EGRESS_ALLOW: options.allow } : {}),
    ...(options.gitUpstream ? { WISP_GIT_UPSTREAM: options.gitUpstream } : {}),
  };
  const script = path.join(directory, "proxy.cjs");
  const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "inherit"] });
  proxies.push(child);
  const control = (input: string) =>
    new Promise<number | null>((resolve) => {
      const client = spawn(process.execPath, [script, "control"], { env, stdio: ["pipe", "ignore", "inherit"] });
      client.once("exit", resolve);
      client.stdin!.end(input);
    });
  return new Promise((resolve, reject) => {
    child.stdout!.on("data", (data: Buffer) => {
      const match = /listening (\d+) git (\d+)/.exec(String(data));
      if (match) resolve({ port: Number(match[1]), gitPort: Number(match[2]), control });
    });
    child.once("exit", () => reject(new Error("proxy exited")));
  });
}

/** Sends raw bytes to the proxy and collects everything it answers until it closes or goes quiet. */
function exchange(port: number, request: string, settleMs = 300): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    let received = "";
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      socket.destroy();
      resolve(received);
    };
    socket.on("data", (data) => {
      received += String(data);
      clearTimeout(timer);
      timer = setTimeout(finish, settleMs);
    });
    socket.on("close", finish);
    socket.on("error", finish);
  });
}

describe("egress proxy address check", () => {
  /** Runs the script without starting its server, to reach the function that classifies addresses. */
  function loadIsPublic(): (address: string) => boolean {
    const fakeServer = { on: () => undefined, listen: () => undefined, address: () => ({ port: 0 }) };
    const context = vm.createContext({
      require: (name: string) =>
        name === "node:http"
          ? { createServer: () => fakeServer }
          : name === "node:net"
            ? { ...(require("node:net") as object), createServer: () => fakeServer }
            : (require(name) as unknown),
      process: { env: {} },
      console,
      Buffer,
      URL,
    });
    vm.runInContext(EGRESS_PROXY_SCRIPT, context);
    return context.isPublic as (address: string) => boolean;
  }

  it("allows public addresses and refuses every local, private and reserved one", () => {
    const isPublic = loadIsPublic();
    for (const address of ["4.228.31.150", "8.8.8.8", "140.82.112.3", "2606:4700::1111", "2a00:1450:4001::64"]) {
      expect(isPublic(address), address).toBe(true);
    }
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.100.100.100",
      "127.0.0.1",
      "169.254.169.254",
      "172.17.0.1",
      "192.168.3.50",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "::ffff:7f00:1",
      "fd7a:115c:a1e0::53",
      "fe80::1",
      "ff02::1",
      "64:ff9b::a00:1",
    ]) {
      expect(isPublic(address), address).toBe(false);
    }
  });
});

describe("egress proxy", () => {
  let port: number;
  beforeAll(async () => {
    ({ port } = await startProxy());
  });

  it.each([
    "127.0.0.1:443",
    "localhost:443",
    "[::1]:443",
    "10.1.2.3:22",
    "192.168.1.1:80",
    "169.254.169.254:80",
    "[::ffff:10.0.0.1]:443",
    "100.64.0.1:443",
  ])("refuses CONNECT to %s", async (destination) => {
    const answer = await exchange(port, `CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\n`);
    expect(answer).toMatch(/^HTTP\/1\.1 403/);
    expect(answer).toContain("blocks connections to local and private network addresses");
  });

  it("refuses plain HTTP to a local address", async () => {
    const answer = await exchange(
      port,
      `GET http://127.0.0.1:${targetPort}/secret HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`,
    );
    expect(answer).toMatch(/^HTTP\/1\.1 403/);
  });

  it("rejects malformed targets", async () => {
    expect(await exchange(port, "CONNECT nonsense:99999 HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 502/);
    expect(await exchange(port, "GET /relative HTTP/1.1\r\nHost: x\r\n\r\n")).toMatch(/^HTTP\/1\.1 400/);
  });
});

describe("egress proxy to an allowed address", () => {
  let port: number;
  beforeAll(async () => {
    ({ port } = await startProxy({ allow: "127.0.0.1/32" }));
  });

  it("tunnels CONNECT to the destination", async () => {
    const answer = await exchange(
      port,
      `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET /through HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    );
    expect(answer).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(answer).toContain('"path":"/through"');
  });

  it("forwards plain HTTP without the proxy's own headers", async () => {
    const answer = await exchange(
      port,
      `GET http://127.0.0.1:${targetPort}/page?q=1 HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nProxy-Authorization: Basic abc\r\nConnection: close\r\n\r\n`,
    );
    expect(answer).toMatch(/^HTTP\/1\.1 200/);
    expect(answer).toContain('"path":"/page?q=1"');
    expect(answer).not.toContain("proxy-authorization");
  });
});

describe("git gateway", () => {
  let proxy: Proxy;
  beforeAll(async () => {
    proxy = await startProxy({ gitUpstream: `http://127.0.0.1:${targetPort}` });
  });

  async function send(
    pathname: string,
    init: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
  ) {
    const response = await fetch(`http://127.0.0.1:${proxy.gitPort}${pathname}`, { redirect: "manual", ...init });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  }

  it.each([
    ["GET", "/repos/owner/repo"],
    ["GET", "/owner/repo/pulls"],
    ["GET", "/owner/repo.git/info/refs"],
    ["GET", "/owner/repo.git/info/refs?service=git-upload-archive"],
    ["POST", "/owner/repo.git/info/refs?service=git-upload-pack"],
    ["GET", "/owner/repo.git/git-receive-pack"],
    ["POST", "/owner/repo.git/git-upload-pack?x=1"],
    ["GET", "/owner/../info/refs?service=git-upload-pack"],
    ["POST", "/graphql"],
  ])("refuses %s %s, which is not git", async (method, pathname) => {
    await expect(proxy.control(JSON.stringify({ address: "127.0.0.1", token: "fake-token" }))).resolves.toBe(0);
    const answer = await send(pathname, { method });
    expect(answer.status).toBe(403);
    expect(answer.text).toContain("carries only git");
  });

  it("adds the token for the address a request arrives on, and replaces the client's own", async () => {
    await expect(proxy.control(JSON.stringify({ address: "127.0.0.1", token: "fake-token" }))).resolves.toBe(0);
    const answer = await send("/owner/repo.git/info/refs?service=git-upload-pack", {
      headers: { authorization: "Bearer stolen", cookie: "session=1", "git-protocol": "version=2" },
    });
    expect(answer.status).toBe(200);
    const seen = JSON.parse(answer.text) as { path: string; headers: Record<string, string> };
    expect(seen.path).toBe("/owner/repo.git/info/refs?service=git-upload-pack");
    expect(seen.headers.authorization).toBe(`Basic ${Buffer.from("x-access-token:fake-token").toString("base64")}`);
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers["git-protocol"]).toBe("version=2");
  });

  it("sends requests without a token once it is taken away, so public repositories still work", async () => {
    await expect(proxy.control(JSON.stringify({ address: "127.0.0.1", token: null }))).resolves.toBe(0);
    const answer = await send("/owner/repo/info/refs?service=git-receive-pack");
    expect((JSON.parse(answer.text) as { headers: Record<string, string> }).headers.authorization).toBeUndefined();
  });

  it("streams a large pack to github.com", async () => {
    const body = Buffer.alloc(5 * 1024 * 1024, 7);
    const answer = await send("/owner/repo.git/git-receive-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request" },
      body,
    });
    expect(JSON.parse(answer.text)).toMatchObject({ method: "POST", bytes: body.length });
  });

  it("keeps a moved repository's redirect on the gateway", async () => {
    const answer = await send("/old/repo.git/info/refs?service=git-upload-pack");
    expect(answer.status).toBe(301);
    expect(answer.headers.get("location")).toBe(
      `http://127.0.0.1:${proxy.gitPort}/new/repo.git/info/refs?service=git-upload-pack`,
    );
  });

  it("refuses control messages it cannot use", async () => {
    await expect(proxy.control("not json")).resolves.toBe(1);
    await expect(proxy.control(JSON.stringify({ address: "wisp-egress", token: "x" }))).resolves.toBe(1);
    await expect(proxy.control(JSON.stringify({ address: "127.0.0.1", token: "has space" }))).resolves.toBe(1);
  });
});

const run = promisify(execFile);

/**
 * git itself, cloning and pushing through the gateway to a fake GitHub on
 * loopback: git's own HTTP backend behind a check for the token. Nothing
 * reaches github.com.
 */
describe("git through the gateway", () => {
  let root: string;
  let fakeGitHub: http.Server;
  let proxy: Proxy;
  const token = "fake-token-for-tests";

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wisp-git-gateway-"));
    const projects = path.join(root, "projects");
    await mkdir(path.join(projects, "owner"), { recursive: true });
    const bare = path.join(projects, "owner", "repo.git");
    await run("git", ["init", "--bare", "-b", "main", bare]);
    await run("git", ["-C", bare, "config", "http.receivepack", "true"]);
    fakeGitHub = http.createServer((request, response) => {
      const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }).end();
        return;
      }
      const url = new URL(request.url!, "http://github.invalid");
      const backend = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: projects,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: request.method!,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          ...(request.headers["content-encoding"]
            ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] }
            : {}),
          ...(request.headers["git-protocol"] ? { GIT_PROTOCOL: request.headers["git-protocol"] } : {}),
          REMOTE_USER: "x-access-token",
          REMOTE_ADDR: "127.0.0.1",
        },
      });
      request.pipe(backend.stdin);
      let head = Buffer.alloc(0);
      let headersDone = false;
      backend.stdout.on("data", (chunk: Buffer) => {
        if (headersDone) return void response.write(chunk);
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        headersDone = true;
        let status = 200;
        for (const line of head.subarray(0, end).toString().split("\r\n")) {
          const [name, ...value] = line.split(":");
          if (name!.toLowerCase() === "status") status = Number.parseInt(value.join(":").trim(), 10);
          else response.setHeader(name!, value.join(":").trim());
        }
        response.writeHead(status);
        response.write(head.subarray(end + 4));
      });
      backend.on("close", () => response.end());
    });
    await new Promise<void>((resolve) => fakeGitHub.listen(0, "127.0.0.1", resolve));
    proxy = await startProxy({ gitUpstream: `http://127.0.0.1:${(fakeGitHub.address() as net.AddressInfo).port}` });
  });

  afterAll(async () => {
    await new Promise((resolve) => fakeGitHub.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  /** git as a Wisp's container runs it: github.com goes to the gateway, and there is no credential to find. */
  function git(cwd: string, ...args: string[]) {
    return run("git", ["-c", `url.http://127.0.0.1:${proxy.gitPort}/.insteadOf=https://github.com/`, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Wisp",
        GIT_AUTHOR_EMAIL: "wisp@example.invalid",
        GIT_COMMITTER_NAME: "Wisp",
        GIT_COMMITTER_EMAIL: "wisp@example.invalid",
      },
    });
  }

  it("clones and pushes a private repository with the token only the gateway has", async () => {
    await expect(proxy.control(JSON.stringify({ address: "127.0.0.1", token }))).resolves.toBe(0);
    await git(root, "clone", "https://github.com/owner/repo.git", "work");
    const work = path.join(root, "work");
    await writeFile(path.join(work, "README.md"), "hello\n");
    await git(work, "add", "README.md");
    await git(work, "commit", "-m", "Add a readme");
    await git(work, "push", "origin", "HEAD:main");

    const { stdout } = await run("git", ["-C", path.join(root, "projects", "owner", "repo.git"), "log", "--oneline"]);
    expect(stdout).toContain("Add a readme");
    // The remote keeps its github.com address; only the gateway knows where it goes.
    expect((await git(work, "config", "remote.origin.url")).stdout.trim()).toBe("https://github.com/owner/repo.git");
    await git(root, "clone", "https://github.com/owner/repo.git", "again");
  });

  it("fails without the token", async () => {
    await expect(proxy.control(JSON.stringify({ address: "127.0.0.1", token: null }))).resolves.toBe(0);
    await expect(git(root, "clone", "https://github.com/owner/repo.git", "denied")).rejects.toThrow(
      /Authentication failed|could not read Username|401/,
    );
  });
});
