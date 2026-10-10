import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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
    response.end(JSON.stringify({ path: request.url, headers: request.headers }));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetPort = (target.address() as net.AddressInfo).port;
});

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  await new Promise((resolve) => target.close(resolve));
  await rm(directory, { recursive: true, force: true });
});

/** Starts the real proxy script with Node; `allow` lets the test reach its own loopback server. */
async function startProxy(allow?: string): Promise<number> {
  const child = spawn(process.execPath, [path.join(directory, "proxy.cjs")], {
    env: { PATH: process.env.PATH, WISP_EGRESS_PORT: "0", ...(allow ? { WISP_EGRESS_ALLOW: allow } : {}) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  proxies.push(child);
  return new Promise((resolve, reject) => {
    child.stdout!.on("data", (data: Buffer) => {
      const match = /listening (\d+)/.exec(String(data));
      if (match) resolve(Number(match[1]));
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
        name === "node:http" ? { createServer: () => fakeServer } : (require(name) as unknown),
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
    port = await startProxy();
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
    port = await startProxy("127.0.0.1/32");
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
