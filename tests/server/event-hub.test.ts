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

  it("preserves exact replay order across multiple ring buffer wraparounds", () => {
    const hub = new EventHub(3);
    for (let index = 1; index <= 10; index++) {
      hub.publish("conversationChanged", delta(`e${index}`));
    }
    // Buffer holds sequences 8, 9, 10.
    expect(hub.subscribe(`${hub.bootId}:6`, () => undefined)).toMatchObject({ resync: true, replay: [] });

    const from7 = hub.subscribe(`${hub.bootId}:7`, () => undefined);
    expect(from7.resync).toBe(false);
    expect(from7.replay.map((event) => event.id)).toEqual([`${hub.bootId}:8`, `${hub.bootId}:9`, `${hub.bootId}:10`]);
    expect(from7.replay.map((event) => event.payload)).toEqual([delta("e8"), delta("e9"), delta("e10")]);

    const from8 = hub.subscribe(`${hub.bootId}:8`, () => undefined);
    expect(from8.resync).toBe(false);
    expect(from8.replay.map((event) => event.payload)).toEqual([delta("e9"), delta("e10")]);

    const from9 = hub.subscribe(`${hub.bootId}:9`, () => undefined);
    expect(from9.resync).toBe(false);
    expect(from9.replay.map((event) => event.payload)).toEqual([delta("e10")]);

    const from10 = hub.subscribe(`${hub.bootId}:10`, () => undefined);
    expect(from10.resync).toBe(false);
    expect(from10.replay).toEqual([]);
  });

  it("handles exact capacity boundary before and after first overwrite", () => {
    const hub = new EventHub(3);
    const initialCursor = hub.cursor;
    hub.publish("conversationChanged", delta("e1"));
    hub.publish("conversationChanged", delta("e2"));
    hub.publish("conversationChanged", delta("e3"));

    // Exactly full: cursor :0 still replays all 3 events.
    const fullReplay = hub.subscribe(initialCursor, () => undefined);
    expect(fullReplay.resync).toBe(false);
    expect(fullReplay.replay.map((event) => event.payload)).toEqual([delta("e1"), delta("e2"), delta("e3")]);

    // One more publish evicts sequence 1: cursor :0 must resync, cursor :1 replays [2, 3, 4].
    hub.publish("conversationChanged", delta("e4"));
    expect(hub.subscribe(initialCursor, () => undefined)).toMatchObject({ resync: true, replay: [] });
    const afterEvict = hub.subscribe(`${hub.bootId}:1`, () => undefined);
    expect(afterEvict.resync).toBe(false);
    expect(afterEvict.replay.map((event) => event.payload)).toEqual([delta("e2"), delta("e3"), delta("e4")]);
  });

  it("handles capacity 1, capacity 0, and unsubscribe cleanly", () => {
    const one = new EventHub(1);
    one.publish("conversationChanged", delta("a"));
    one.publish("conversationChanged", delta("b"));
    expect(one.subscribe(`${one.bootId}:0`, () => undefined)).toMatchObject({ resync: true, replay: [] });
    const latest = one.subscribe(`${one.bootId}:1`, () => undefined);
    expect(latest.resync).toBe(false);
    expect(latest.replay.map((event) => event.payload)).toEqual([delta("b")]);

    const zero = new EventHub(0);
    expect(zero.subscribe(zero.cursor, () => undefined)).toMatchObject({ resync: false, replay: [] });
    const before = zero.cursor;
    zero.publish("conversationChanged", delta("a"));
    expect(zero.subscribe(before, () => undefined)).toMatchObject({ resync: true, replay: [] });
    expect(zero.subscribe(zero.cursor, () => undefined)).toMatchObject({ resync: false, replay: [] });

    const seen: string[] = [];
    const sub = one.subscribe(undefined, (event) => seen.push(event.id));
    one.publish("conversationChanged", delta("c"));
    sub.unsubscribe();
    one.publish("conversationChanged", delta("d"));
    expect(seen).toEqual([`${one.bootId}:3`]);
  });
});
