import { describe, expect, it } from "vitest";

import { locateTailscale, runTailscale, Tailscale } from "../../electron/local-server/tailscale.js";
import { FakeTailscale } from "../helpers/fake-tailscale.js";

describe("locateTailscale", () => {
  it("finds the CLI on PATH first, then where each platform installs it", () => {
    const only = (file: string) => (candidate: string) => candidate === file;
    expect(locateTailscale("linux", { PATH: "/home/me/bin:/usr/bin" }, only("/home/me/bin/tailscale"))).toBe(
      "/home/me/bin/tailscale",
    );
    // Apps started from the Dock get no Homebrew or app bundle on PATH.
    const bundle = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    expect(locateTailscale("darwin", { PATH: "/usr/bin:/bin" }, only(bundle))).toBe(bundle);
    expect(locateTailscale("darwin", { PATH: "/usr/bin" }, only("/opt/homebrew/bin/tailscale"))).toBe(
      "/opt/homebrew/bin/tailscale",
    );
    expect(
      locateTailscale(
        "win32",
        { PATH: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
        only("C:\\Program Files\\Tailscale\\tailscale.exe"),
      ),
    ).toBe("C:\\Program Files\\Tailscale\\tailscale.exe");
    expect(locateTailscale("linux", { PATH: "/usr/bin" }, () => false)).toBeUndefined();
  });
});

describe("Tailscale", () => {
  it("leaves a serve alone once someone changed it", async () => {
    const cli = new FakeTailscale();
    const tailscale = new Tailscale({ locate: cli.locate, run: cli.run });
    expect(await tailscale.serve(8787)).toEqual({ origin: "https://laptop.tailnet.ts.net", created: true });
    cli.handler = "http://127.0.0.1:3000";
    await tailscale.unserve(8787);
    expect(cli.handler).toBe("http://127.0.0.1:3000");
    expect(cli.calls.some((args) => args.includes("off"))).toBe(false);
  });

  it("stops waiting for the CLI once it asks for consent in a browser", async () => {
    const started = Date.now();
    const result = await runTailscale(
      process.execPath,
      [
        "-e",
        "console.log('To enable, visit:\\n\\n  https://login.tailscale.com/f/serve?node=n1'); setTimeout(() => {}, 60000)",
      ],
      { timeoutMs: 20_000, until: /https:\/\/login\.tailscale\.com\/f\/serve\S*/ },
    );
    expect(result.output).toContain("https://login.tailscale.com/f/serve?node=n1");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
