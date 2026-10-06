import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import { McpSecretStore } from "../backend/mcp-secret-store.js";

const encryption: EncryptionService = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value, "utf8"),
  decrypt: (value) => value.toString("utf8"),
};

describe("McpSecretStore", () => {
  it("persists client registration before tokens exist", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-mcp-secrets-"));
    const store = new McpSecretStore(path.join(directory, "mcp-credentials.enc.json"), encryption);

    // Dynamic registration completes before the first token exchange.
    await store.setOAuthClientRegistration("server-1", { clientId: "client-1" });
    expect(await store.oauthClientRegistration("server-1")).toEqual({ clientId: "client-1" });
    // The registration-only placeholder carries no usable tokens.
    expect(await store.hasOAuthTokens("server-1")).toBe(false);
    expect(await store.oauthTokens("server-1")).toBeUndefined();
  });

  it("keeps the client registration across token writes and invalidations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-mcp-secrets-"));
    const filePath = path.join(directory, "mcp-credentials.enc.json");
    const store = new McpSecretStore(filePath, encryption);

    await store.setOAuthTokens("server-1", { accessToken: "stale", refreshToken: "refresh-1" });
    await store.setOAuthClientRegistration("server-1", { clientId: "client-1", clientSecret: "s3cret" });
    // A later token write must not overwrite the registration.
    await store.setOAuthTokens("server-1", { accessToken: "fresh", refreshToken: "refresh-2" });
    expect(await store.oauthTokens("server-1")).toMatchObject({ accessToken: "fresh", refreshToken: "refresh-2" });
    expect(await store.oauthClientRegistration("server-1")).toMatchObject({ clientId: "client-1" });

    // Invalidation resets only the tokens; the client identity stays.
    await store.clearOAuthTokens("server-1");
    expect(await store.hasOAuthTokens("server-1")).toBe(false);
    expect(await store.oauthClientRegistration("server-1")).toMatchObject({ clientId: "client-1" });
  });

  it("restores registration and tokens through a reload", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-mcp-secrets-"));
    const filePath = path.join(directory, "mcp-credentials.enc.json");
    const writer = new McpSecretStore(filePath, encryption);
    await writer.setOAuthClientRegistration("server-1", { clientId: "client-1" });
    await writer.setOAuthTokens("server-1", { accessToken: "at" });

    const reader = new McpSecretStore(filePath, encryption);
    expect(await reader.oauthClientRegistration("server-1")).toEqual({ clientId: "client-1" });
    expect(await reader.oauthTokens("server-1")).toMatchObject({ accessToken: "at" });
    expect(await reader.hasOAuthTokens("server-1")).toBe(true);
  });

  it("stores header secrets and deletes them per server", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-mcp-secrets-"));
    const store = new McpSecretStore(path.join(directory, "mcp-credentials.enc.json"), encryption);
    await store.setHeader("server-1", "Authorization", "Bearer sekrit");
    expect(await store.read("server-1")).toMatchObject({ type: "header", headerName: "Authorization" });
    await store.delete("server-1");
    expect(await store.read("server-1")).toBeUndefined();
  });
});
