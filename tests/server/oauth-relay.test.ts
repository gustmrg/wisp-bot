import { describe, expect, it, vi } from "vitest";

import { openOAuthRelay, type AskSignInDevice } from "../../server/oauth-relay.js";

describe("openOAuthRelay", () => {
  it("asks the app for a listener, relays the redirect and closes it once", async () => {
    const ask = vi.fn<AskSignInDevice>(async (request) => {
      if (request.kind === "oauthListen") return ["listener-1", "45678"];
      if (request.kind === "oauthRedirect") return ["code=abc&state=s1"];
      return [];
    });
    const relay = await openOAuthRelay(ask);
    expect(relay.port).toBe(45_678);

    await expect(relay.waitForRedirect("https://auth.example.com/authorize?state=s1", "s1")).resolves.toBe(
      "code=abc&state=s1",
    );
    expect(ask).toHaveBeenCalledWith(
      {
        kind: "oauthRedirect",
        listenerId: "listener-1",
        url: "https://auth.example.com/authorize?state=s1",
        state: "s1",
      },
      expect.any(Number),
    );
    relay.close();
    relay.close();
    expect(ask.mock.calls.filter(([request]) => request.kind === "oauthClose")).toEqual([
      [{ kind: "oauthClose", listenerId: "listener-1" }, expect.any(Number)],
    ]);
  });

  it.each([[["listener-1"]], [["listener-1", "0"]], [["listener-1", "70000"]], [["", "45678"]]])(
    "refuses an answer without a usable port: %j",
    async (answer) => {
      await expect(openOAuthRelay(async () => answer)).rejects.toThrow();
    },
  );

  it("fails when the app cannot listen, so the server can fall back", async () => {
    await expect(
      openOAuthRelay(async () => {
        throw new Error("Not available.");
      }),
    ).rejects.toThrow("Not available.");
  });
});
