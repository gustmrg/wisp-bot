import { describe, expect, it, vi } from "vitest";

import { resolveAutoInstallSupport } from "../electron/backend/update-capability.js";

function codesign(ok: boolean, output: string) {
  return vi.fn(async () => ({ ok, output }));
}

describe("resolveAutoInstallSupport", () => {
  it("treats a Developer ID signature as auto-installable", async () => {
    const runCodesign = codesign(
      true,
      "Executable=.../Wisp Bot.app/Contents/MacOS/Wisp Bot\nTeamIdentifier=ABCDEF1234\n",
    );
    await expect(
      resolveAutoInstallSupport("darwin", "/Applications/Wisp Bot.app/Contents/MacOS/Wisp Bot", runCodesign),
    ).resolves.toBe(true);
    expect(runCodesign).toHaveBeenCalledWith("/Applications/Wisp Bot.app");
  });

  it("requires manual download for ad-hoc signatures and unsigned bundles", async () => {
    const adhoc = codesign(true, "Executable=.../Wisp Bot.app\nSignature=adhoc\nTeamIdentifier=not set\n");
    await expect(
      resolveAutoInstallSupport("darwin", "/Applications/Wisp Bot.app/Contents/MacOS/Wisp Bot", adhoc),
    ).resolves.toBe(false);

    const unsigned = codesign(false, "code object is not signed at all");
    await expect(
      resolveAutoInstallSupport("darwin", "/Applications/Wisp Bot.app/Contents/MacOS/Wisp Bot", unsigned),
    ).resolves.toBe(false);
  });

  it("requires manual download when codesign cannot run", async () => {
    const failing = vi.fn(async () => {
      throw new Error("codesign missing");
    });
    await expect(
      resolveAutoInstallSupport("darwin", "/Applications/Wisp Bot.app/Contents/MacOS/Wisp Bot", failing),
    ).resolves.toBe(false);
  });

  it("skips the signature check outside macOS", async () => {
    const runCodesign = codesign(true, "");
    await expect(resolveAutoInstallSupport("win32", "C:\\Apps\\Wisp Bot\\Wisp Bot.exe", runCodesign)).resolves.toBe(
      true,
    );
    expect(runCodesign).not.toHaveBeenCalled();
  });
});
