import { describe, expect, it } from "vitest";

import { normalizeChat, normalizeChatChanges } from "../electron/backend/conversation-normalizer.js";
import { normalizeWispTone, sameWispTone, storedWispTone } from "../shared/wisp-tone.js";

const FORMAL_TONE = { style: "formal", length: "default", custom: "" };

const wisp = {
  id: "research",
  kind: "wisp",
  name: "Research",
  label: "",
  description: "",
  notifyOnUpdatesEnabled: true,
  preview: "",
  timestamp: "",
  shape: "circle",
  messages: [],
};

describe("Wisp tone", () => {
  it("keeps configured tones and collapses default ones", () => {
    expect(normalizeWispTone({ style: "formal", length: "default", custom: "" })).toEqual({
      style: "formal",
      length: "default",
      custom: "",
    });
    expect(normalizeWispTone({ style: "default", length: "default", custom: "" })).toBeUndefined();
    expect(storedWispTone(undefined)).toBeUndefined();
  });

  it("keeps custom text only for the custom style", () => {
    expect(normalizeWispTone({ style: "custom", length: "short", custom: "  Upbeat  " })).toEqual({
      style: "custom",
      length: "short",
      custom: "Upbeat",
    });
    expect(normalizeWispTone({ style: "friendly", length: "default", custom: "ignored" })?.custom).toBe("");
    expect(normalizeWispTone({ style: "custom", length: "default", custom: "   " })).toBeUndefined();
  });

  it("rejects unknown values", () => {
    expect(() => normalizeWispTone({ style: "loud", length: "default", custom: "" })).toThrow();
    expect(() => normalizeWispTone({ style: "formal", length: "long", custom: "" })).toThrow();
    expect(() => normalizeWispTone({ style: "formal", length: "short", custom: "", extra: 1 })).toThrow();
    expect(() => normalizeWispTone({ style: "custom", length: "short", custom: "x".repeat(501) })).toThrow();
  });

  it("treats a missing tone as the default tone", () => {
    expect(sameWispTone(undefined, { style: "default", length: "default", custom: "" })).toBe(true);
    expect(sameWispTone(undefined, { style: "direct", length: "default", custom: "" })).toBe(false);
  });

  it("stores a Wisp tone, drops a default one, and rejects tones on circles", () => {
    expect(normalizeChat({ ...wisp, tone: { style: "direct", length: "short", custom: "" } })).toMatchObject({
      tone: { style: "direct", length: "short" },
    });
    expect(normalizeChat({ ...wisp, tone: { style: "default", length: "default", custom: "" } })).not.toHaveProperty(
      "tone",
    );
    expect(() =>
      normalizeChat({ ...wisp, kind: "circle", memberIds: [], shape: undefined, tone: FORMAL_TONE }),
    ).toThrow();
  });

  it("accepts tone changes for Wisps only and lets an undefined tone clear it", () => {
    expect(normalizeChatChanges({ kind: "wisp", tone: { style: "casual", length: "detailed", custom: "" } })).toEqual({
      kind: "wisp",
      tone: { style: "casual", length: "detailed", custom: "" },
    });
    const cleared = normalizeChatChanges({ kind: "wisp", tone: undefined });
    expect(Object.hasOwn(cleared, "tone")).toBe(true);
    expect(() => normalizeChatChanges({ kind: "circle", tone: FORMAL_TONE })).toThrow();
  });
});
