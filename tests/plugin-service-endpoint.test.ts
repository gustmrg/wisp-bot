import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginService } from "../backend/plugin-service.js";
import type { PluginAdapter, PluginToolSpec } from "../backend/plugin-types.js";
import type { EncryptionService } from "../backend/encrypted-credential-store.js";
import { isLocalHost, parsePluginEndpoint } from "../backend/plugin-validation.js";
import { ownConversation } from "../backend/integration-tool-source.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A service with a fake Home Assistant adapter; no request leaves the test. */
async function setup() {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "wisp-plugin-endpoint-"));
  directories.push(dataDirectory);
  const encryption: EncryptionService = {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value.split("").reverse().join("")),
    decrypt: (value) => value.toString().split("").reverse().join(""),
  };
  const execute = vi.fn(async () => "Home result");
  const testConnection = vi.fn(async () => "Connected to Home");
  const read: PluginToolSpec = {
    name: "home_assistant_list_entities",
    label: "List",
    description: "List",
    parameters: { type: "object", properties: {}, additionalProperties: false } as PluginToolSpec["parameters"],
    access: "read",
    summarize: () => "List",
    execute,
  };
  const adapters: PluginAdapter[] = [{ id: "home-assistant", tools: [read], testConnection }];
  const service = new PluginService({
    dataDirectory,
    encryption,
    authorizationBroker: { authorize: vi.fn(async () => undefined) },
    adapters,
    resolveWisp: () => "session-one",
  });
  await service.load();
  const grant = () => {
    const { revision } = service.getAccess({ conversationId: "one" });
    return service.saveAccess({
      conversationId: "one",
      revision,
      grants: [{ pluginId: "home-assistant", access: "read" }],
    });
  };
  const call = () =>
    service
      .getTools(ownConversation("one"))
      .find(({ name }) => name === "home_assistant_list_entities")!
      .execute("tool-1", {}, undefined, undefined, {} as never);
  return { service, dataDirectory, execute, testConnection, grant, call };
}

describe("plugins that connect to the user's own server", () => {
  it("accepts HTTPS anywhere and HTTP only on local networks and tailnets", () => {
    expect(parsePluginEndpoint(" http://homeassistant.local:8123/ ")).toBe("http://homeassistant.local:8123");
    expect(parsePluginEndpoint("https://home.example.com/ha/")).toBe("https://home.example.com/ha");
    for (const host of [
      "192.168.1.10",
      "10.0.0.2",
      "172.20.1.1",
      "100.101.102.103",
      "[fd12::1]",
      "pi.tail1234.ts.net",
      "homeassistant",
    ]) {
      expect(parsePluginEndpoint(`http://${host}:8123`)).toMatch(/^http:/);
    }
    for (const host of ["home.example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "[2001:db8::1]"]) {
      expect(() => parsePluginEndpoint(`http://${host}:8123`)).toThrow(/Use HTTPS/);
    }
    expect(() => parsePluginEndpoint("https://user:pass@home.example.com")).toThrow(/user name or password/);
    expect(() => parsePluginEndpoint("https://home.example.com/?token=x")).toThrow(/server address/);
    expect(() => parsePluginEndpoint("ftp://homeassistant.local")).toThrow(/server address/);
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("1234")).toBe(false);
  });

  it("requires the address with the key, tests and stores them together, and shows the address", async () => {
    const { service, dataDirectory, testConnection } = await setup();
    expect(() => service.save({ pluginId: "home-assistant", enabled: true, apiKey: "ha-token" })).toThrow(
      /address of the server/,
    );
    expect(() =>
      service.save({ pluginId: "linear", enabled: true, apiKey: "key", endpoint: "https://x.example" }),
    ).toThrow(/configuration is invalid/);

    await service.testConnection({
      pluginId: "home-assistant",
      apiKey: "ha-token",
      endpoint: "http://homeassistant.local:8123/",
    });
    expect(testConnection).toHaveBeenLastCalledWith(
      "ha-token",
      expect.any(AbortSignal),
      "http://homeassistant.local:8123",
    );

    const view = await service.save({
      pluginId: "home-assistant",
      enabled: true,
      apiKey: "ha-token",
      endpoint: "http://homeassistant.local:8123",
    });
    expect(view.plugins.find(({ id }) => id === "home-assistant")).toMatchObject({
      configured: true,
      enabled: true,
      endpoint: "http://homeassistant.local:8123",
    });
    // The token is stored encrypted, never in the settings file.
    expect(await readFile(path.join(dataDirectory, "plugins.json"), "utf8")).not.toContain("ha-token");

    await service.testConnection({ pluginId: "home-assistant" });
    expect(testConnection).toHaveBeenLastCalledWith(
      "ha-token",
      expect.any(AbortSignal),
      "http://homeassistant.local:8123",
    );
  });

  it("runs tools with the stored address, and a new address revokes every Wisp's access", async () => {
    const { service, execute, grant, call } = await setup();
    const save = (endpoint: string) =>
      service.save({ pluginId: "home-assistant", enabled: true, apiKey: "ha-token", endpoint });
    const access = () =>
      service.getAccess({ conversationId: "one" }).grants.find(({ pluginId }) => pluginId === "home-assistant")?.access;
    await save("http://homeassistant.local:8123");
    await grant();
    await call();
    expect(execute).toHaveBeenCalledWith("ha-token", {}, expect.any(AbortSignal), "http://homeassistant.local:8123");

    // Same key and address: access stays.
    await save("http://homeassistant.local:8123");
    expect(access()).toBe("read");
    // Another server may be another home.
    await save("https://other.example.com");
    expect(access()).toBe("none");
  });
});
