import { afterEach, describe, expect, it, vi } from "vitest";

import { homeAssistant } from "../backend/plugins/home-assistant.js";
import { getToolMetadata } from "../shared/tool-catalog.js";

const TOKEN = "ha-token-must-not-appear";
const HA = "http://homeassistant.local:8123";
const tool = (name: string) => {
  const found = homeAssistant.tools.find((item) => item.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
};
const run = (name: string, input: unknown) => tool(name).execute(TOKEN, input, undefined, HA);

const STATES = [
  {
    entity_id: "light.kitchen",
    state: "on",
    attributes: { friendly_name: "Kitchen light", brightness: 200 },
    last_changed: "2026-10-17T10:00:00+00:00",
  },
  {
    entity_id: "sensor.living_room_temperature",
    state: "22.5",
    attributes: { friendly_name: "Living room temperature", unit_of_measurement: "°C" },
  },
  { entity_id: "cover.garage", state: "closed", attributes: { friendly_name: "Garage", device_class: "garage" } },
  { entity_id: "cover.blinds", state: "open", attributes: { friendly_name: "Blinds", device_class: "blind" } },
  { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front door" } },
];
const AREAS = [
  ["light.kitchen", "Kitchen"],
  ["sensor.living_room_temperature", "Living Room"],
];

/**
 * Answers Home Assistant's API by method and path; strings are sent as text.
 * Every request is recorded. No network is used.
 */
function mockHa(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = routes[`${init?.method ?? "GET"} ${new URL(url).pathname}`];
    if (body === undefined) return Response.json({ message: "Entity not found." }, { status: 404 });
    if (body instanceof Response) return body;
    return typeof body === "string" ? new Response(body) : Response.json(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const calls = (fetchMock: ReturnType<typeof mockHa>) =>
  fetchMock.mock.calls.map(([url, init]) => ({
    method: init?.method ?? "GET",
    url: new URL(url),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  }));
const serviceCall = (fetchMock: ReturnType<typeof mockHa>) =>
  calls(fetchMock).find(({ url }) => url.pathname.startsWith("/api/services/"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Home Assistant plugin", () => {
  it("reads states and controls a fixed set of actions, with locks, alarms, and doors in their own tool", () => {
    expect(homeAssistant.oauth).toBeUndefined();
    expect(homeAssistant.tools.map(({ name, access }) => [name, access])).toEqual([
      ["home_assistant_list_entities", "read"],
      ["home_assistant_get_state", "read"],
      ["home_assistant_get_history", "read"],
      ["home_assistant_control", "write"],
      ["home_assistant_control_secure", "write"],
      ["home_assistant_run_scene", "write"],
      ["home_assistant_run_script", "write"],
    ]);
    // No generic service call: a Wisp cannot restart Home Assistant or run shell commands.
    expect(homeAssistant.tools.some(({ name }) => /call_service|restart/.test(name))).toBe(false);
    for (const { name } of homeAssistant.tools) {
      expect(getToolMetadata(name)).toMatchObject({ pluginId: "home-assistant" });
    }
  });

  it("tests the connection with the home's name and version", async () => {
    const fetchMock = mockHa({ "GET /api/config": { location_name: "Casa", version: "2026.10.1" } });
    await expect(homeAssistant.testConnection(TOKEN, undefined, HA)).resolves.toBe(
      "Connected to Casa (Home Assistant 2026.10.1).",
    );
    const [request] = calls(fetchMock);
    expect(request!.url.toString()).toBe(`${HA}/api/config`);
    expect(request!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("lists entities with their areas and filters by domain, area, and words", async () => {
    const fetchMock = mockHa({ "GET /api/states": STATES, "POST /api/template": JSON.stringify(AREAS) });
    const all = JSON.parse(await run("home_assistant_list_entities", {}));
    expect(all.total).toBe(5);
    expect(all.entities[2]).toEqual({ entityId: "light.kitchen", name: "Kitchen light", state: "on", area: "Kitchen" });
    expect(all.entities[4]).toMatchObject({ entityId: "sensor.living_room_temperature", unit: "°C" });
    expect(calls(fetchMock).find(({ method }) => method === "POST")!.body.template).toContain("area_name");

    const kitchen = JSON.parse(await run("home_assistant_list_entities", { area: "kitchen" }));
    expect(kitchen.entities.map(({ entityId }: { entityId: string }) => entityId)).toEqual(["light.kitchen"]);
    const covers = JSON.parse(await run("home_assistant_list_entities", { domain: "cover", search: "gar", limit: 5 }));
    expect(covers.entities.map(({ entityId }: { entityId: string }) => entityId)).toEqual(["cover.garage"]);
  });

  it("lists without areas when the token cannot render templates, and says so", async () => {
    mockHa({ "GET /api/states": STATES, "POST /api/template": Response.json({}, { status: 403 }) });
    const result = JSON.parse(await run("home_assistant_list_entities", { domain: "light" }));
    expect(result).toMatchObject({ total: 1, areasUnavailable: true });
    expect(result.entities[0].area).toBeUndefined();
    await expect(run("home_assistant_list_entities", { area: "Kitchen" })).rejects.toThrow(/Areas are unavailable/);
  });

  it("reads one entity with bounded attributes, and its history", async () => {
    const fetchMock = mockHa({
      "GET /api/states/light.kitchen": {
        ...STATES[0],
        attributes: { ...STATES[0]!.attributes, note: "x".repeat(900) },
      },
      "POST /api/template": JSON.stringify(AREAS),
    });
    const state = JSON.parse(await run("home_assistant_get_state", { entityId: "light.kitchen" }));
    expect(state).toMatchObject({
      entityId: "light.kitchen",
      area: "Kitchen",
      lastChanged: "2026-10-17T10:00:00+00:00",
    });
    expect(state.attributes.note).toMatch(/… \[truncated\]$/);
    await expect(run("home_assistant_get_state", { entityId: "../config" })).rejects.toThrow(/Invalid entityId/);

    fetchMock.mockImplementation(async () =>
      Response.json([
        [
          { entity_id: "light.kitchen", state: "off", last_changed: "a" },
          { state: "on", last_changed: "b" },
        ],
      ]),
    );
    const history = JSON.parse(await run("home_assistant_get_history", { entityId: "light.kitchen", hours: 2 }));
    const request = calls(fetchMock).at(-1)!;
    expect(request.url.pathname).toMatch(/^\/api\/history\/period\/\d{4}-\d{2}-\d{2}T/);
    expect(request.url.searchParams.get("filter_entity_id")).toBe("light.kitchen");
    expect(history.changes).toEqual([
      { state: "off", at: "a" },
      { state: "on", at: "b" },
    ]);
  });

  it("calls only the service each action maps to, with the value it sets", async () => {
    const fetchMock = mockHa({
      "POST /api/services/light/turn_on": [{ entity_id: "light.kitchen", state: "on", attributes: {} }],
      "POST /api/services/media_player/volume_set": [],
    });
    const result = JSON.parse(
      await run("home_assistant_control", {
        entityId: "light.kitchen",
        action: "set_brightness",
        brightnessPercent: 40,
      }),
    );
    expect(serviceCall(fetchMock)!.body).toEqual({ entity_id: "light.kitchen", brightness_pct: 40 });
    expect(result).toMatchObject({ entityId: "light.kitchen", state: "on" });

    fetchMock.mockClear();
    const volume = JSON.parse(
      await run("home_assistant_control", { entityId: "media_player.tv", action: "set_volume", volumePercent: 25 }),
    );
    expect(serviceCall(fetchMock)!.body).toEqual({ entity_id: "media_player.tv", volume_level: 0.25 });
    expect(volume.note).toMatch(/accepted/);

    await expect(
      run("home_assistant_control", { entityId: "light.kitchen", action: "turn_on", volumePercent: 10 }),
    ).rejects.toThrow(/takes no value/);
    await expect(
      run("home_assistant_control", { entityId: "light.kitchen", action: "set_brightness" }),
    ).rejects.toThrow(/needs brightnessPercent/);
    await expect(run("home_assistant_control", { entityId: "lock.front_door", action: "turn_off" })).rejects.toThrow(
      /home_assistant_control_secure/,
    );
    await expect(run("home_assistant_control", { entityId: "homeassistant.core", action: "turn_off" })).rejects.toThrow(
      /does not apply/,
    );
  });

  it("keeps garage doors out of the ordinary tool and opens them only through the secure one", async () => {
    const fetchMock = mockHa({
      "GET /api/states/cover.garage": STATES[2],
      "GET /api/states/cover.blinds": STATES[3],
      "POST /api/services/cover/close_cover": [],
      "POST /api/services/cover/open_cover": [],
      "POST /api/services/lock/unlock": [],
    });
    await expect(run("home_assistant_control", { entityId: "cover.garage", action: "open" })).rejects.toThrow(
      /Garage doors/,
    );
    expect(serviceCall(fetchMock)).toBeUndefined();
    await run("home_assistant_control", { entityId: "cover.blinds", action: "close" });
    expect(serviceCall(fetchMock)!.url.pathname).toBe("/api/services/cover/close_cover");

    fetchMock.mockClear();
    await run("home_assistant_control_secure", { entityId: "cover.garage", action: "open" });
    expect(serviceCall(fetchMock)!.url.pathname).toBe("/api/services/cover/open_cover");

    fetchMock.mockClear();
    await run("home_assistant_control_secure", { entityId: "lock.front_door", action: "unlock", code: "1234" });
    expect(serviceCall(fetchMock)!.body).toEqual({ entity_id: "lock.front_door", code: "1234" });
    // The code is not shown on the approval card.
    expect(
      tool("home_assistant_control_secure").summarize({ entityId: "lock.front_door", action: "unlock", code: "1234" }),
    ).toBe("unlock lock.front_door");
    await expect(run("home_assistant_control_secure", { entityId: "light.kitchen", action: "open" })).rejects.toThrow(
      /locks, alarms, and doors/,
    );
  });

  it("activates scenes and runs scripts only of their own domain", async () => {
    const fetchMock = mockHa({ "POST /api/services/scene/turn_on": [], "POST /api/services/script/turn_on": [] });
    await run("home_assistant_run_scene", { entityId: "scene.movie_night" });
    expect(serviceCall(fetchMock)!.body).toEqual({ entity_id: "scene.movie_night" });
    await expect(run("home_assistant_run_scene", { entityId: "script.good_night" })).rejects.toThrow(/scene entity/);
    await expect(run("home_assistant_run_script", { entityId: "lock.front_door" })).rejects.toThrow(/script entity/);
  });

  it("explains a refused token without leaking it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: TOKEN }, { status: 401 })),
    );
    const failure = await run("home_assistant_get_state", { entityId: "light.kitchen" }).catch((error: Error) => error);
    expect(String(failure)).toMatch(/long-lived access token/);
    expect(String(failure)).not.toContain(TOKEN);
  });
});
