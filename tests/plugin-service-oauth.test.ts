import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WispBackendError } from "../backend/backend-error.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import type { SignInBrowser } from "../backend/oauth-redirect.js";
import type { PluginOAuthConfig } from "../backend/plugin-oauth.js";
import { PluginService } from "../backend/plugin-service.js";
import type { PluginAdapter, PluginToolSpec } from "../backend/plugin-types.js";
import type { PluginSettingsView } from "../shared/plugins.js";
import { ownConversation } from "../backend/integration-tool-source.js";

const directories: string[] = [];
const services: PluginService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const OAUTH: PluginOAuthConfig = {
  authorizationEndpoint: "https://accounts.example.com/authorize",
  tokenEndpoint: "https://oauth.example.com/token",
  revocationEndpoint: "https://oauth.example.com/revoke",
  scopes: ["calendar.read", "calendar.write"],
  authorizationParams: { access_type: "offline", prompt: "consent" },
  account: async (accessToken) => (accessToken.startsWith("other") ? "other@example.com" : "me@example.com"),
};

/** The token endpoint, answering from a queue; every request is recorded. No provider is contacted. */
function fakeTokenServer() {
  const requests: Array<{ url: string; body: URLSearchParams }> = [];
  const answers: Array<{ status?: number; body: Record<string, unknown> }> = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
    if (url === OAUTH.revocationEndpoint) return new Response("", { status: 200 });
    const answer = answers.shift() ?? { status: 500, body: { error: "server_error" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  const grant = (access = "access-1", refresh = "refresh-1", scope = OAUTH.scopes.join(" ")) =>
    answers.push({ body: { access_token: access, refresh_token: refresh, expires_in: 3600, scope } });
  return { fetchFn, requests, answers, grant };
}

async function setup({ signInBrowser }: { signInBrowser?: () => Promise<SignInBrowser> } = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "wisp-plugin-oauth-"));
  directories.push(dataDirectory);
  const encryption: EncryptionService = {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString(),
  };
  const opened: string[] = [];
  const pushed: PluginSettingsView[] = [];
  const execute = vi.fn(async (credential: string) => `used ${credential}`);
  const spec = (name: string, access: "read" | "write"): PluginToolSpec => ({
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false } as PluginToolSpec["parameters"],
    access,
    summarize: () => "Create an event",
    execute,
  });
  // Stands in for a sign-in plugin; the bundled catalog entry only supplies a name.
  const adapter: PluginAdapter = {
    id: "linear",
    tools: [spec("linear_get_issue", "read"), spec("linear_update_issue", "write")],
    testConnection: async (credential) => `Connected with ${credential}`,
    oauth: OAUTH,
  };
  const tokens = fakeTokenServer();
  const service = new PluginService({
    dataDirectory,
    encryption,
    authorizationBroker: { authorize: vi.fn(async () => undefined) },
    adapters: [adapter],
    resolveWisp: (id) => `session-${id}`,
    openExternal: async (url) => {
      opened.push(url);
    },
    fetch: tokens.fetchFn,
    onSettingsChanged: (view) => pushed.push(view),
    ...(signInBrowser ? { signInBrowser } : {}),
  });
  services.push(service);
  await service.load();
  const view = async () => (await service.getView()).plugins.find(({ id }) => id === "linear")!;
  /** Follows the browser to the loopback callback with this flow's state. */
  const approve = async (query = "code=the-code") => {
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
    const page = new URL(opened.at(-1)!);
    const redirect = page.searchParams.get("redirect_uri")!;
    return fetch(`${redirect}?${query}&state=${page.searchParams.get("state")}`);
  };
  const grant = (access: "none" | "read" | "write") => {
    const { revision } = service.getAccess({ conversationId: "one" });
    return service.saveAccess({ conversationId: "one", revision, grants: [{ pluginId: "linear", access }] });
  };
  const call = (name: string) =>
    service
      .getTools(ownConversation("one"))
      .find((tool) => tool.name === name)!
      .execute("tool-1", {}, undefined, undefined, {} as never);
  return { service, tokens, opened, pushed, execute, view, approve, grant, call };
}

describe("PluginService browser sign-in", () => {
  it("signs in with the user's OAuth client using PKCE and stores tokens, not just the client", async () => {
    const { service, tokens, opened, view, approve, grant, call } = await setup();
    tokens.grant();
    const signIn = service.startSignIn({ pluginId: "linear", clientId: "client-1", clientSecret: "secret-1" });
    await vi.waitFor(async () => expect((await view()).signInPending).toBe(true));

    const page = new URL(opened[0]!.toString());
    expect(page.origin + page.pathname).toBe("https://accounts.example.com/authorize");
    expect(Object.fromEntries(page.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      scope: "calendar.read calendar.write",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    expect(page.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((await approve()).status).toBe(200);
    await signIn;

    const exchange = tokens.requests[0]!.body;
    expect(Object.fromEntries(exchange)).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: "client-1",
      client_secret: "secret-1",
      redirect_uri: page.searchParams.get("redirect_uri"),
    });
    expect(exchange.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(await view()).toMatchObject({ configured: true, enabled: true, account: "me@example.com" });
    expect((await view()).signInPending).toBeUndefined();

    await grant("read");
    expect(await service.getActiveToolNames("one")).toEqual(["linear_get_issue"]);
    expect(await call("linear_get_issue")).toMatchObject({ content: [{ text: "used access-1" }] });
    await expect(service.testConnection({ pluginId: "linear" })).resolves.toEqual({
      message: "Connected with access-1",
    });
  });

  it("renews an expiring token once for concurrent calls, and asks to sign in again when renewal is refused", async () => {
    const { service, tokens, approve, grant, call } = await setup();
    tokens.answers.push({
      body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 30, scope: OAUTH.scopes.join(" ") },
    });
    const signIn = service.startSignIn({ pluginId: "linear", clientId: "client-1" });
    await approve();
    await signIn;
    await grant("read");

    // 30 seconds is inside the renewal margin: both calls share one renewal.
    tokens.answers.push({ body: { access_token: "access-2", expires_in: 3600 } });
    const results = await Promise.all([call("linear_get_issue"), call("linear_get_issue")]);
    expect(results.map((result) => result.content[0])).toEqual([
      { type: "text", text: "used access-2" },
      { type: "text", text: "used access-2" },
    ]);
    const renewals = tokens.requests.filter(({ body }) => body.get("grant_type") === "refresh_token");
    expect(renewals).toHaveLength(1);
    expect(renewals[0]!.body.get("refresh_token")).toBe("refresh-1");
    expect(await call("linear_get_issue")).toMatchObject({ content: [{ text: "used access-2" }] });
  });

  it("turns tools off and reports needing sign-in when the refresh token is refused", async () => {
    const { service, tokens, approve, grant, call, view, pushed } = await setup();
    tokens.answers.push({
      body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 1, scope: OAUTH.scopes.join(" ") },
    });
    const signIn = service.startSignIn({ pluginId: "linear", clientId: "client-1" });
    await approve();
    await signIn;
    await grant("read");

    tokens.answers.push({ status: 400, body: { error: "invalid_grant" } });
    await expect(call("linear_get_issue")).rejects.toMatchObject({
      code: "configuration_required",
      message: expect.stringContaining("Sign in to Linear again"),
    });
    expect(await view()).toMatchObject({ configured: true, needsSignIn: true });
    expect(await service.getActiveToolNames("one")).toEqual([]);
    await vi.waitFor(() => expect(pushed.at(-1)?.plugins.find(({ id }) => id === "linear")?.needsSignIn).toBe(true));
  });

  it("keeps Wisp access when the same account signs in again, and revokes it for another account", async () => {
    const { service, tokens, opened, approve, grant } = await setup();
    tokens.grant();
    let signIn = service.startSignIn({ pluginId: "linear", clientId: "client-1" });
    await approve();
    await signIn;
    await grant("write");

    tokens.grant("access-again");
    signIn = service.startSignIn({ pluginId: "linear" });
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    await approve();
    await signIn;
    expect(
      service.getAccess({ conversationId: "one" }).grants.find(({ pluginId }) => pluginId === "linear"),
    ).toMatchObject({ access: "write" });

    tokens.grant("other-access");
    signIn = service.startSignIn({ pluginId: "linear" });
    await vi.waitFor(() => expect(opened).toHaveLength(3));
    await approve();
    await signIn;
    expect(
      service.getAccess({ conversationId: "one" }).grants.find(({ pluginId }) => pluginId === "linear"),
    ).toMatchObject({ access: "none" });
  });

  it.each([
    ["the user denies access", "error=access_denied", /was not allowed/],
    ["a permission is left unchecked", "code=the-code", /Not every permission was allowed/],
  ])("stores nothing when %s", async (_case, query, message) => {
    const { service, tokens, approve, view } = await setup();
    tokens.grant("access-1", "refresh-1", "calendar.read");
    const signIn = service.startSignIn({ pluginId: "linear", clientId: "client-1" });
    signIn.catch(() => undefined);
    await approve(query);
    await expect(signIn).rejects.toMatchObject({
      code: "configuration_required",
      message: expect.stringMatching(message),
    });
    expect(await view()).toMatchObject({ configured: false, enabled: false });
  });

  it("cancels a waiting sign-in, and a removal during sign-in cannot bring the connection back", async () => {
    const { service, tokens, approve, view, opened } = await setup();
    let signIn = service.startSignIn({ pluginId: "linear", clientId: "client-1" });
    signIn.catch(() => undefined);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    await service.cancelSignIn({ pluginId: "linear" });
    await expect(signIn).rejects.toMatchObject({ code: "aborted", message: "The sign-in was cancelled." });
    expect((await view()).signInPending).toBeUndefined();
    await expect(service.cancelSignIn({ pluginId: "linear" })).rejects.toMatchObject({ code: "not_found" });

    signIn = service.startSignIn({ pluginId: "linear", clientId: "client-1" });
    signIn.catch(() => undefined);
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    await service.remove({ pluginId: "linear" });
    tokens.grant();
    await approve().catch(() => undefined);
    await expect(signIn).rejects.toBeInstanceOf(WispBackendError);
    expect(await view()).toMatchObject({ configured: false });
  });

  it("revokes the provider's grant when the connection is removed", async () => {
    const { service, tokens, approve, view } = await setup();
    tokens.grant();
    const signIn = service.startSignIn({ pluginId: "linear", clientId: "client-1" });
    await approve();
    await signIn;

    await service.remove({ pluginId: "linear" });
    await vi.waitFor(() =>
      expect(tokens.requests.find(({ url }) => url === OAUTH.revocationEndpoint)?.body.get("token")).toBe("refresh-1"),
    );
    expect(await view()).toMatchObject({ configured: false, enabled: false });
  });

  it("lets a device that cannot receive the redirect finish with the pasted address", async () => {
    const { service, tokens, view, opened } = await setup({ signInBrowser: async () => ({ kind: "manual" }) });
    tokens.grant();
    const signIn = service.startSignIn({ pluginId: "linear", clientId: "client-1" });
    let signInUrl: string | undefined;
    await vi.waitFor(async () => {
      signInUrl = (await view()).signInUrl;
      expect(signInUrl).toBeDefined();
    });
    expect(opened).toEqual([]);
    const page = new URL(signInUrl!);
    const redirect = `${page.searchParams.get("redirect_uri")}?code=the-code&state=${page.searchParams.get("state")}`;
    await expect(
      service.finishSignIn({ pluginId: "linear", redirectUrl: redirect.replace(/state=[^&]+/, "state=forged") }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    await service.finishSignIn({ pluginId: "linear", redirectUrl: redirect });
    await signIn;
    expect(await view()).toMatchObject({ configured: true, enabled: true });
    expect((await view()).signInUrl).toBeUndefined();
  });

  it("needs a client for the first sign-in, and never takes an API key or enables before connecting", async () => {
    const { service } = await setup();
    await expect(service.startSignIn({ pluginId: "linear" })).rejects.toMatchObject({
      code: "configuration_required",
      message: "Enter the OAuth client ID and secret.",
    });
    await expect(service.save({ pluginId: "linear", enabled: true, apiKey: "key" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.save({ pluginId: "linear", enabled: true })).rejects.toMatchObject({
      code: "configuration_required",
      message: "Connect this plugin before enabling it.",
    });
  });
});
