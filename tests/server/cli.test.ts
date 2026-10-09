import { describe, expect, it } from "vitest";

import { describeDevices, describePairing } from "../../server/cli.js";

describe("wispctl output for people", () => {
  const now = new Date("2026-10-09T20:18:37.435Z");
  const pairing = { code: "ZJ5GJ-4WD6T", expiresAt: "2026-10-09T20:28:37.435Z" };
  const until = new Date(pairing.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  it("shows the pairing code, how long it lasts, and where to enter it", () => {
    expect(describePairing(pairing, "https://box.tailnet.ts.net", now)).toBe(
      [
        "Pairing code: ZJ5GJ-4WD6T",
        `Valid for 10 minutes (until ${until}).`,
        "",
        "Open https://box.tailnet.ts.net on your phone or browser and enter the code to pair.",
        "",
      ].join("\n"),
    );
  });

  it("points to --public-origin when the server has no public address", () => {
    const text = describePairing(pairing, undefined, new Date("2026-10-09T20:28:00.000Z"));
    expect(text).toContain("Valid for 1 minute (");
    expect(text).toContain("Open this server's address on your phone or browser");
    expect(text).toContain("wispctl setup --public-origin");
  });

  it("lists devices with the IDs revoke takes", () => {
    const text = describeDevices([
      { id: "d1", name: "Desktop", createdAt: now.toISOString(), lastSeenAt: now.toISOString(), local: true },
      { id: "d2", name: "Phone", createdAt: now.toISOString(), lastSeenAt: null, local: false },
    ]);
    expect(text).toMatch(/^2 paired devices:\n\nDesktop \(the desktop app on this computer\)\n {2}ID: d1\n/);
    expect(text).toContain("Phone\n  ID: d2\n  Paired ");
    expect(text).toContain("last seen never\n");
    expect(describeDevices([])).toBe("No paired devices. Run `wispctl pair` to pair one.\n");
  });
});
