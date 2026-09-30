import { describe, expect, it } from "vitest";

import type { Message } from "@/chat-data";
import {
  applyDeltaToWindow,
  extendWindow,
  isAttached,
  MAX_MESSAGE_WINDOWS,
  touchOpened,
  windowFromPage,
} from "@/lib/message-windows";

function message(id: string, text = id): Message {
  return { id, type: "incoming", text };
}

const attached = windowFromPage(1, { messages: [message("c"), message("d")], olderCursor: "3", newerCursor: null });
const detached = windowFromPage(2, { messages: [message("c"), message("d")], olderCursor: "3", newerCursor: "4" }, "c");

describe("message windows", () => {
  it("is attached when it reaches the newest message, and remembers the message it was opened on", () => {
    expect(isAttached(attached)).toBe(true);
    expect(attached.targetMessageId).toBeUndefined();
    expect(isAttached(detached)).toBe(false);
    expect(detached.targetMessageId).toBe("c");
  });

  it("adds a page at its own end and takes that end's cursor", () => {
    const older = extendWindow({ ...detached, loading: true }, "older", {
      messages: [message("a"), message("b")],
      olderCursor: null,
      newerCursor: "3",
    });
    expect(older.messages.map(({ id }) => id)).toEqual(["a", "b", "c", "d"]);
    expect(older).toMatchObject({ epoch: 2, olderCursor: null, newerCursor: "4", loading: false });

    const newer = extendWindow(older, "newer", { messages: [message("e")], olderCursor: "4", newerCursor: null });
    expect(newer.messages.map(({ id }) => id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(newer).toMatchObject({ olderCursor: null, newerCursor: null });
  });

  it("skips messages of a page that the window already holds", () => {
    const extended = extendWindow(attached, "older", {
      messages: [message("b"), message("c", "stale")],
      olderCursor: null,
      newerCursor: null,
    });
    expect(extended.messages).toEqual([message("b"), message("c"), message("d")]);
  });
});

describe("applyDeltaToWindow", () => {
  it("adds new messages to an attached window and updates held ones in place", () => {
    const next = applyDeltaToWindow(attached, { added: [message("e")], updated: [message("c", "edited")] });

    expect(next.messages).toEqual([message("c", "edited"), message("d"), message("e")]);
    expect(applyDeltaToWindow(next, { added: [message("e")], updated: [message("c", "edited")] }).messages).toEqual(
      next.messages,
    );
  });

  it("leaves new messages out of a detached window but still updates the ones it holds", () => {
    const next = applyDeltaToWindow(detached, { added: [message("z")], updated: [message("d", "edited")] });

    expect(next.messages).toEqual([message("c"), message("d", "edited")]);
  });

  it("ignores an update to a message outside the window instead of appending it", () => {
    expect(applyDeltaToWindow(attached, { added: [], updated: [message("a", "edited")] })).toBe(attached);
    expect(applyDeltaToWindow(attached, { added: [], updated: [] })).toBe(attached);
  });
});

describe("touchOpened", () => {
  it("keeps the most recently opened conversations and names the ones to drop", () => {
    let opened: ReadonlyArray<string> = [];
    for (const id of ["a", "b", "c", "d", "e"]) opened = touchOpened(opened, id).opened;
    expect(opened).toHaveLength(MAX_MESSAGE_WINDOWS);

    expect(touchOpened(opened, "b")).toEqual({ opened: ["b", "e", "d", "c", "a"], evicted: [] });
    expect(touchOpened(opened, "f")).toEqual({ opened: ["f", "e", "d", "c", "b"], evicted: ["a"] });
  });
});
