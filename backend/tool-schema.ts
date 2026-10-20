import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import { z } from "zod";

import { WispBackendError } from "./backend-error.js";

type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

/**
 * One of Wisp's own tools, with its parameters as a zod schema. The type of
 * `params` comes from the schema, so the two cannot drift apart.
 */
export interface WispTool<TSchema extends z.ZodType> {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: z.output<TSchema>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ): Promise<ToolResult>;
}

/**
 * The tool as Pi and Claude Code take it: the parameters as JSON Schema, and
 * an `execute` that parses the arguments with the schema first, so invalid
 * ones fail with a clear message before the tool runs, whichever runtime
 * called it.
 */
export function defineWispTool<TSchema extends z.ZodType>(tool: WispTool<TSchema>): ToolDefinition {
  const { parameters, execute, ...rest } = tool;
  return {
    ...rest,
    parameters: toolParameters(parameters),
    execute: async (toolCallId, params, signal, onUpdate, ctx) =>
      execute(toolCallId, parseToolArguments(parameters, params), signal, onUpdate, ctx),
  };
}

/**
 * The JSON Schema the model sees, describing what it may send. Leaves out
 * `$schema`, which some providers reject in tool parameters, and the safe
 * integer bounds zod adds to every integer.
 */
export function toolParameters(schema: z.ZodType): ToolDefinition["parameters"] {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      if (jsonSchema.type !== "integer") return;
      if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum;
      if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum;
    },
  });
  return parameters as unknown as ToolDefinition["parameters"];
}

export function parseToolArguments<TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // One sentence per problem, naming the argument, as the model reads it.
  const problems = result.error.issues.map((issue) => {
    const message = /[.!?]$/.test(issue.message) ? issue.message : `${issue.message}.`;
    return issue.path.length ? `Invalid ${issue.path.join(".")}: ${message}` : message;
  });
  throw new WispBackendError("invalid_request", problems.join(" "));
}
