import { describe, expect, it } from "vitest";

import { browserCheckUrl } from "../../electron/connections/ssh-check.js";
import { classify } from "../../electron/connections/ssh-tunnel.js";
import { listTailnetMachines, parseTailscaleStatus } from "../../electron/connections/tailnet.js";

describe("tailnet machines", () => {
  it("lists Linux peers by MagicDNS name, online ones first", () => {
    const status = JSON.stringify({
      Self: { HostName: "laptop", DNSName: "laptop.tail1234.ts.net.", OS: "linux" },
      Peer: {
        a: {
          HostName: "Old Pi",
          DNSName: "old-pi.tail1234.ts.net.",
          OS: "linux",
          Online: false,
          TailscaleIPs: ["100.64.0.3", "fd7a::3"],
        },
        b: { HostName: "phone", DNSName: "phone.tail1234.ts.net.", OS: "iOS", Online: true },
        c: {
          HostName: "nas",
          DNSName: "nas.tail1234.ts.net.",
          OS: "linux",
          Online: true,
          TailscaleIPs: ["fd7a::2", "100.64.0.2"],
        },
        d: { HostName: "odd", DNSName: "-oops.ts.net.", OS: "linux", Online: true },
      },
    });
    expect(parseTailscaleStatus(status)).toEqual([
      { name: "nas", dnsName: "nas.tail1234.ts.net", ip: "100.64.0.2", online: true },
      { name: "old-pi", dnsName: "old-pi.tail1234.ts.net", ip: "100.64.0.3", online: false },
    ]);
    expect(parseTailscaleStatus("not json")).toEqual([]);
  });

  it("lists nothing without the tailscale command", async () => {
    expect(await listTailnetMachines({ tailscalePath: "/nonexistent/tailscale" })).toEqual([]);
  });

  it("finds Tailscale SSH's approval page, and explains a check a background connection cannot pass", () => {
    const stderr =
      "# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/l1abc\n";
    expect(browserCheckUrl(stderr)).toBe("https://login.tailscale.com/a/l1abc");
    expect(browserCheckUrl("To authenticate, visit: http://example.com")).toBeUndefined();
    expect(classify(stderr, "pi", undefined).message).toBe(
      "Tailscale SSH asks you to approve connections to pi in your browser. Retry to approve it.",
    );
  });
});
