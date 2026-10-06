import { describe, expect, it } from "vitest";

import { EventHub, type HubEvent } from "../../server/event-hub.js";

const delta = (id: string) => ({ chat: { id } }) as never;

describe("EventHub", () => {
  it("delivers new events in order with one sequence", () => {
    const hub = new EventHub();
    const received: HubEvent[] = [];
    hub.subscribe(undefined, (event) => received.push(event));
    hub.publish("conversationChanged", delta("a"));
    hub.publish("mcpSettingsChanged", { servers: [] } as never);
    expect(received.map((event) => event.id)).toEqual([`${hub.bootId}:1`, `${hub.bootId}:2`]);
    expect(received.map((event) => event.type)).toEqual(["conversationChanged", "mcpSettingsChanged"]);
  });

  it("replays what a reconnecting client missed", () => {
    const hub = new EventHub();
    hub.publish("conversationChanged", delta("a"));
    const cursor = hub.cursor;
    hub.publish("conversationChanged", delta("b"));
    hub.publish("conversationChanged", delta("c"));
    const subscription = hub.subscribe(cursor, () => undefined);
    expect(subscription.resync).toBe(false);
    expect(subscription.replay.map((event) => event.payload)).toEqual([delta("b"), delta("c")]);
    expect(hub.subscribe(hub.cursor, () => undefined).replay).toEqual([]);
  });

  it("asks for a resync when the cursor is from another boot, malformed, or older than the buffer", () => {
    const hub = new EventHub(2);
    const start = hub.cursor;
    for (const id of ["a", "b", "c"]) hub.publish("conversationChanged", delta(id));
    expect(hub.subscribe(start, () => undefined).resync).toBe(true);
    expect(hub.subscribe(`${hub.bootId}:1`, () => undefined).resync).toBe(false);
    expect(hub.subscribe(new EventHub().cursor, () => undefined).resync).toBe(true);
    expect(hub.subscribe("garbage", () => undefined).resync).toBe(true);
    expect(hub.subscribe(`${hub.bootId}:99`, () => undefined).resync).toBe(true);
  });
});
