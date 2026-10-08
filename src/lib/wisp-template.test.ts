import { describe, expect, it } from "vitest";

import { WISP_SOUL_MAX_LENGTH } from "../../shared/conversations";
import { parseWispTemplate, serializeWispTemplate } from "@/lib/wisp-template";

const wisp = { name: "Atlas", role: "Research", soul: "# Who you are\nA careful researcher." };

describe("Wisp templates", () => {
  it("round-trips a Wisp with its model", () => {
    const model = { providerId: "anthropic", modelId: "claude-sonnet-5-5", maxOutputTokens: 4096 };
    expect(parseWispTemplate(serializeWispTemplate(wisp, model))).toEqual({ ok: true, template: { ...wisp, model } });
  });

  it("round-trips a Wisp without a model", () => {
    expect(parseWispTemplate(`\n${serializeWispTemplate(wisp, null)}\n`)).toEqual({ ok: true, template: wisp });
  });

  it("asks for an update when a newer app made the template", () => {
    const text = JSON.stringify({ format: "wisp-template", version: 2, ...wisp });
    expect(parseWispTemplate(text)).toEqual({ ok: false, error: expect.stringContaining("newer version") });
  });

  it.each([
    ["plain text", "Atlas"],
    ["another format", JSON.stringify({ format: "other", version: 1, ...wisp })],
    ["an empty name", JSON.stringify({ format: "wisp-template", version: 1, ...wisp, name: " " })],
    ["a missing soul", JSON.stringify({ format: "wisp-template", version: 1, name: "Atlas", role: "" })],
    [
      "an oversized soul",
      JSON.stringify({ format: "wisp-template", version: 1, ...wisp, soul: "x".repeat(WISP_SOUL_MAX_LENGTH + 1) }),
    ],
    [
      "a model without an ID",
      JSON.stringify({ format: "wisp-template", version: 1, ...wisp, model: { providerId: "a" } }),
    ],
    [
      "an invalid output limit",
      JSON.stringify({
        format: "wisp-template",
        version: 1,
        ...wisp,
        model: { providerId: "a", modelId: "b", maxOutputTokens: 0 },
      }),
    ],
  ])("rejects %s", (_case, text) => {
    expect(parseWispTemplate(text)).toEqual({ ok: false, error: expect.stringContaining("not a valid Wisp template") });
  });
});
