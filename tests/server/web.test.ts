import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StructuredLogger } from "../../backend/structured-logger.js";
import { adminRequest } from "../../server/admin.js";
import { MasterKeyEncryption } from "../../server/master-key.js";
import { createWispServer, type WispServer } from "../../server/wisp-server.js";

const silent = new StructuredLogger({ info: () => undefined, warn: () => undefined });
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request, so tests control Host, Origin, and cookies exactly as a browser would send them. */
function send(
  server: WispServer,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${server.url}${options.path}`,
      {
        method: options.method ?? "GET",
        headers: { ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      },
    );
    request.on("error", reject);
    request.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

async function setup(options: { webRoot?: boolean; publicOrigin?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisp-web-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const webRoot = path.join(root, "web");
  await mkdir(path.join(webRoot, "assets"), { recursive: true });
  await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>Wisp</title>");
  await writeFile(path.join(webRoot, "sw.js"), "self.addEventListener('fetch', () => {});");
  await writeFile(path.join(webRoot, "assets", "main-abc123.js"), "console.log('app');");
  await writeFile(path.join(root, "secret.txt"), "outside the web root");
  const dataDirectory = path.join(root, "data");
  const server = await createWispServer({
    dataDirectory,
    host: "127.0.0.1",
    port: 0,
    encryption: new MasterKeyEncryption(randomBytes(32)),
    logger: silent,
    agentMode: "fake",
    appVersion: "1.0.0",
    allowModelNetwork: false,
    ...(options.webRoot === false ? {} : { webRoot }),
    ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
  });
  cleanups.push(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;
  const code = async () => ((await adminRequest(dataDirectory, { command: "pair" })) as { code: string }).code;
  return { server, origin, code, dataDirectory };
}

function cookieHeader(reply: Reply): string {
  const cookies = reply.headers["set-cookie"] ?? [];
  return (Array.isArray(cookies) ? cookies : [cookies]).map((cookie) => cookie.split(";")[0]).join("; ");
}

describe("browser app", () => {
  it("serves the app with its policy, routes unknown paths to it, and never reads outside its folder", async () => {
    const { server } = await setup();
    const index = await send(server, { path: "/" });
    expect(index.status).toBe(200);
    expect(index.body).toContain("<title>Wisp</title>");
    expect(index.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(index.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect((await send(server, { path: "/chats/atlas" })).body).toContain("<title>Wisp</title>");
    for (const outside of ["/../secret.txt", "/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      expect((await send(server, { path: outside })).body, outside).not.toContain("outside the web root");
    }
    const asset = await send(server, { path: "/assets/main-abc123.js" });
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect((await send(server, { path: "/sw.js" })).headers["cache-control"]).toBe("no-cache");
    expect((await send(server, { method: "HEAD", path: "/" })).body).toBe("");
    // The API is never shadowed by the app.
    expect((await send(server, { path: "/api/v1/server" })).status).toBe(401);
  });

  it("answers only the API without a web root", async () => {
    const { server } = await setup({ webRoot: false });
    expect((await send(server, { path: "/" })).status).toBe(404);
  });

  it("pairs a browser with HttpOnly cookies and never hands it a token", async () => {
    const { server, origin, code } = await setup();
    const headers = { Origin: origin, "X-Wisp-Request": "1" };
    // Pairing a browser needs the app's own origin.
    expect(
      (
        await send(server, {
          method: "POST",
          path: "/api/v1/auth/pair",
          body: { code: await code(), deviceName: "x", mode: "web" },
        })
      ).status,
    ).toBe(403);
    const paired = await send(server, {
      method: "POST",
      path: "/api/v1/auth/pair",
      headers,
      body: { code: await code(), deviceName: "Safari on iPhone", mode: "web" },
    });
    expect(paired.status).toBe(200);
    const value = JSON.parse(paired.body).value;
    expect(Object.keys(value).sort()).toEqual(["accessExpiresAt", "deviceId", "serverId"]);
    const cookies = paired.headers["set-cookie"] as string[];
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain("Secure");
    }
    expect(cookies.find((cookie) => cookie.startsWith("wisp_refresh="))).toContain("Path=/api/v1/auth");
    const jar = cookieHeader(paired);

    // Reads need only the cookie; changes also need the app's origin and header.
    expect((await send(server, { path: "/api/v1/server", headers: { Cookie: jar } })).status).toBe(200);
    const rpc = (extra: Record<string, string>) =>
      send(server, {
        method: "POST",
        path: "/api/v1/rpc/getConversationState",
        headers: { Cookie: jar, ...extra },
        body: {},
      });
    expect((await rpc({})).status).toBe(403);
    expect((await rpc({ Origin: origin })).status).toBe(403);
    expect((await rpc({ Origin: "https://attacker.example", "X-Wisp-Request": "1" })).status).toBe(403);
    expect((await rpc(headers)).status).toBe(200);

    // Refreshing rotates the cookies, and like any change it needs the app's origin and header.
    const refreshed = await send(server, {
      method: "POST",
      path: "/api/v1/auth/refresh",
      headers: { ...headers, Cookie: jar },
    });
    expect(refreshed.status).toBe(200);
    const rotated = cookieHeader(refreshed);
    expect(rotated).not.toBe(jar);
    expect(
      (await send(server, { method: "POST", path: "/api/v1/auth/refresh", headers: { Cookie: jar } })).status,
    ).toBe(403);

    const loggedOut = await send(server, {
      method: "POST",
      path: "/api/v1/auth/logout",
      headers: { ...headers, Cookie: rotated },
      body: {},
    });
    expect(loggedOut.status).toBe(200);
    expect((loggedOut.headers["set-cookie"] as string[]).every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
    expect(server.auth.devices()).toEqual([]);
    expect((await send(server, { path: "/api/v1/server", headers: { Cookie: rotated } })).status).toBe(401);
  });

  it("marks cookies Secure behind a private HTTPS proxy", async () => {
    const publicOrigin = "https://wisp.example.ts.net";
    const { server, code } = await setup({ publicOrigin });
    const paired = await send(server, {
      method: "POST",
      path: "/api/v1/auth/pair",
      headers: { Host: "wisp.example.ts.net", Origin: publicOrigin, "X-Wisp-Request": "1" },
      body: { code: await code(), deviceName: "Phone", mode: "web" },
    });
    expect(paired.status).toBe(200);
    expect((paired.headers["set-cookie"] as string[]).every((cookie) => cookie.includes("Secure"))).toBe(true);
  });
});
