import { describe, expect, it } from "vitest";

import { renderUnicodeCompact } from "uqr";

import { describeDevices, describePairing, pairingLink } from "../../server/cli.js";

describe("wispctl output for people", () => {
  const now = new Date("2026-10-09T20:18:37.435Z");
  const pairing = { code: "ZJ5GJ-4WD6T", expiresAt: "2026-10-09T20:28:37.435Z" };
  const until = new Date(pairing.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  it("puts the code in the link's fragment, which browsers never send", () => {
    expect(pairingLink("https://box.tailnet.ts.net", "ZJ5GJ-4WD6T")).toBe(
      "https://box.tailnet.ts.net/#pair=ZJ5GJ-4WD6T",
    );
  });

  it("shows a QR code of the pairing link, the link, the code, and how long it lasts", () => {
    const link = "https://box.tailnet.ts.net/#pair=ZJ5GJ-4WD6T";
    expect(describePairing(pairing, "https://box.tailnet.ts.net", now)).toBe(
      [
        "Pairing code: ZJ5GJ-4WD6T",
        `Valid for 10 minutes (until ${until}).`,
        "",
        "Scan this with your phone to pair:",
        "",
        renderUnicodeCompact(link, { border: 2 }),
        "",
        `Or open ${link} on your phone or browser to pair,`,
        "or open https://box.tailnet.ts.net and enter the code.",
        "",
        "Anyone with this QR code, link, or code can pair: do not share it or leave it on screen.",
        "",
      ].join("\n"),
    );
  });

  it("leaves the QR code out with --no-qr", () => {
    const text = describePairing(pairing, "https://box.tailnet.ts.net", now, { qr: false });
    expect(text).not.toContain("▄");
    expect(text).toContain("Open https://box.tailnet.ts.net/#pair=ZJ5GJ-4WD6T on your phone or browser to pair,");
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
