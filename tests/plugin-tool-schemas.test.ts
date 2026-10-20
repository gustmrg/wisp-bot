import { describe, expect, it } from "vitest";

import { PLUGIN_ADAPTERS } from "../backend/plugins/index.js";
import before from "./fixtures/plugin-tool-schemas.json";

/** The plugins declared `required: []` on tools without required arguments; zod leaves it out. */
function withoutEmptyRequired(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutEmptyRequired);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key, value]) => !(key === "required" && Array.isArray(value) && value.length === 0))
      .map(([key, value]) => [key, withoutEmptyRequired(value)]),
  );
}

const tools = PLUGIN_ADAPTERS.flatMap((adapter) =>
  adapter.tools.map((tool) => [adapter.id, tool.name, tool.parameters] as const),
);

describe("plugin tool schemas", () => {
  it("covers every plugin tool", () => {
    const expected = Object.entries(before).flatMap(([adapter, schemas]) =>
      Object.keys(schemas).map((name) => `${adapter}/${name}`),
    );
    expect(tools.map(([adapter, name]) => `${adapter}/${name}`)).toEqual(expected);
  });

  // The fixture holds the JSON Schemas the tools declared by hand before zod.
  it.each(tools)("gives %s %s the JSON Schema it had before zod", (adapter, name, parameters) => {
    const schemas = before as Record<string, Record<string, unknown>>;
    expect(parameters).toEqual(withoutEmptyRequired(schemas[adapter]![name]));
  });
});
