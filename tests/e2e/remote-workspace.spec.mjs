import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "playwright/test";

const require = createRequire(import.meta.url);
const { createWispServer } = require("../../dist-server/server/application.js");

/** A local TLS reverse proxy exercises the same cookie/origin boundary as Tailscale Serve. */
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "wisp-browser-"));
  const key = path.join(directory, "tls.key");
  const certificate = path.join(directory, "tls.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  let server;
  const proxy = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (incoming, outgoing) => {
    const upstream = request(
      `${server.url}${incoming.url}`,
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 500, response.headers);
        outgoing.flushHeaders();
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  server = await createWispServer({
    dataDirectory: path.join(directory, "state"),
    publicOrigin: origin,
    port: 0,
    agentMode: "fake",
    fakeLatencyMs: 40,
    ownerName: "Remote owner",
    webRoot: path.resolve("dist-web"),
    admin: false,
  });
  return {
    server,
    origin,
    async close() {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function pair(page, fixture, name) {
  await page.goto(fixture.origin);
  await page.getByRole("textbox", { name: "Device name" }).fill(name);
  await page.getByLabel("Pairing code", { exact: true }).fill(fixture.server.auth.createPairingCode().code);
  await page.getByRole("button", { name: "Pair this device" }).click();
  await expect(page.getByRole("button", { name: "Manage connections" })).toBeVisible();
}

test("two browsers share remote history, recover offline, and keep authentication outside storage", async ({
  browser,
  browserName,
}) => {
  const remote = await fixture();
  const desktop = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const phone = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const first = await desktop.newPage();
  const second = await phone.newPage();
  const pageErrors = [];
  first.on("pageerror", (error) => pageErrors.push(error.message));
  second.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await pair(first, remote, "Desktop browser");
    await pair(second, remote, "Phone browser");
    await first.getByRole("button", { name: "Create Wisp", exact: true }).click();
    const create = first.getByRole("dialog", { name: "Create new Wisp" });
    await create.getByRole("textbox", { name: "Name", exact: true }).fill("Atlas");
    await create.getByRole("button", { name: "Create Wisp", exact: true }).click();
    await expect(first.getByRole("textbox", { name: "Message Atlas" })).toBeVisible();
    await second.getByRole("button", { name: /Atlas/ }).click();
    await expect(second.getByRole("textbox", { name: "Message Atlas" })).toBeVisible();
    await expect(second.getByRole("navigation", { name: "Wisps and circles" })).toHaveCount(0);
    await first.getByRole("textbox", { name: "Message Atlas" }).fill("Share this response");
    await first.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      first.getByRole("log").getByText("Fake response to: Share this response", { exact: true }),
    ).toBeVisible();
    await expect(
      second.getByRole("log").getByText("Fake response to: Share this response", { exact: true }),
    ).toBeVisible();
    await phone.setOffline(true);
    await first.getByRole("textbox", { name: "Message Atlas" }).fill("Produced while the phone is offline");
    await first.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      first.getByRole("log").getByText("Fake response to: Produced while the phone is offline", { exact: true }),
    ).toBeVisible();
    await phone.setOffline(false);
    await second.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(
      second.getByRole("log").getByText("Fake response to: Produced while the phone is offline", { exact: true }),
    ).toBeVisible();
    await expect(
      second.getByRole("log").getByText("Fake response to: Produced while the phone is offline", { exact: true }),
    ).toHaveCount(1);
    await first.screenshot({ path: "/tmp/wisp-remote-desktop.png" });
    await second.screenshot({ path: "/tmp/wisp-remote-phone.png" });
    await second.getByRole("button", { name: "Open Wisp settings" }).click();
    await expect(second.getByRole("button", { name: "Close details" })).toBeVisible();
    const horizontalOverflow = await second.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(horizontalOverflow).toBe(false);
    // A dirty editor must retain its read revision after another browser's save reaches it over SSE.
    await first.getByRole("button", { name: "Open Wisp settings" }).click();
    await second.getByRole("textbox", { name: "Identity & personality" }).fill("An old unsaved draft");
    await first.getByRole("textbox", { name: "Identity & personality" }).fill("Saved on the other device");
    await first.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(first.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await expect(second.getByText("This Wisp changed on the server. Reload before saving your changes.")).toBeVisible();
    await second.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(second.getByRole("alert").filter({ hasText: "Could not save Wisp settings." })).toBeVisible();
    await expect(second.getByRole("textbox", { name: "Identity & personality" })).toHaveValue("An old unsaved draft");
    await second.getByRole("button", { name: "Reload server settings" }).click();
    await expect(second.getByRole("textbox", { name: "Identity & personality" })).toHaveValue(
      "Saved on the other device",
    );
    await first.getByRole("button", { name: "Close details" }).click();
    await second.getByRole("button", { name: "Close details" }).click();
    await second.getByRole("button", { name: "Back to conversations" }).click();
    await expect(second.getByRole("navigation", { name: "Wisps and circles" })).toBeVisible();
    // Reload after an expired access cookie must use the protected refresh session.
    const phoneDevice = remote.server.auth.devices().find((device) => device.name === "Phone browser");
    remote.server.database.sql
      .prepare("UPDATE tokens SET expires_at=0 WHERE device_id=? AND kind='access'")
      .run(phoneDevice.id);
    await second.reload();
    await expect(second.getByRole("button", { name: "Manage connections" })).toBeVisible();
    await expect(second.getByRole("button", { name: /Atlas/ })).toBeVisible();
    const cookies = await desktop.cookies();
    expect(
      cookies
        .filter(({ name }) => name.startsWith("wisp_"))
        .every((cookie) => cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict"),
    ).toBe(true);
    expect(await first.evaluate(() => document.cookie)).not.toContain("wisp_");
    const browserStorage = await first.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(JSON.stringify(browserStorage)).not.toMatch(/accessToken|refreshToken|csrfToken/);
    const csrfStatus = await first.evaluate(
      async () =>
        (
          await fetch("/api/v1/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
    );
    expect(csrfStatus).toBe(403);
    if (browserName === "chromium") {
      await first.evaluate(() => navigator.serviceWorker.ready);
      const cached = await first.evaluate(async () =>
        (
          await Promise.all(
            (
              await caches.keys()
            ).map(async (key) =>
              (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname),
            ),
          )
        ).flat(),
      );
      expect(cached).toContain("/index.html");
      expect(cached.some((url) => url.startsWith("/api/"))).toBe(false);
    }
    await first.getByRole("button", { name: "Manage connections" }).click();
    await first.getByRole("button", { name: "Sign out of this device" }).click();
    await expect(first.getByRole("heading", { name: "Connect to Wisp" })).toBeVisible();
    await expect(second.getByRole("button", { name: "Manage connections" })).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await desktop.close();
    await phone.close();
    await remote.close();
  }
});
