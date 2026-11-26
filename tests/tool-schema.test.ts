import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { PROCESS_PARAMETERS } from "../backend/execution-service.js";
import { SAVE_JOB_STATE_PARAMETERS, SKIP_DELIVERY_PARAMETERS } from "../backend/job-runner.js";
import {
  CANCEL_JOB_PARAMETERS,
  LIST_JOBS_PARAMETERS,
  SCHEDULE_JOB_PARAMETERS,
  UPDATE_JOB_PARAMETERS,
} from "../backend/job-tools.js";
import { defineWispTool, toolParameters } from "../backend/tool-schema.js";
import {
  SAVE_SKILL_PARAMETERS,
  SEARCH_HISTORY_PARAMETERS,
  USE_SKILL_PARAMETERS,
} from "../backend/wisp-session-plan.js";
import {
  ASK_WISP_PARAMETERS,
  CREATE_CIRCLE_PARAMETERS,
  CREATE_WISP_PARAMETERS,
  DELETE_WISP_PARAMETERS,
  LIST_CIRCLES_PARAMETERS,
  LIST_WISPS_PARAMETERS,
  UPDATE_CIRCLE_PARAMETERS,
  UPDATE_WISP_PARAMETERS,
} from "../backend/wisp-tools.js";
import { THINKING_LEVELS } from "../shared/contracts.js";
import { WISP_NAME_MAX_LENGTH, WISP_ROLE_MAX_LENGTH, WISP_SOUL_MAX_LENGTH } from "../shared/conversations.js";
import { MAX_JOB_INSTRUCTIONS_LENGTH, MAX_JOB_SKILLS, MAX_JOB_TITLE_LENGTH, MAX_JOB_TOOLS } from "../shared/jobs.js";
import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_INSTRUCTIONS_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  SKILL_NAME_PATTERN,
} from "../shared/skills.js";
import { WISP_BODIES, WISP_COLORS } from "../shared/wisp-appearance.js";

// The JSON Schemas the tools declared by hand before zod; the generated ones must stay the same.
const WISP_FIELDS = {
  name: { type: "string", minLength: 1, maxLength: WISP_NAME_MAX_LENGTH, description: "The Wisp's name." },
  role: {
    type: "string",
    maxLength: WISP_ROLE_MAX_LENGTH,
    description: "A short role or profession shown under the name, such as Research.",
  },
  soul: {
    type: "string",
    maxLength: WISP_SOUL_MAX_LENGTH,
    description: "Markdown that defines the Wisp's identity, personality, how it works, and its boundaries.",
  },
  color: { type: "string", enum: WISP_COLORS.map(({ id }) => id), description: "The Wisp's color." },
  body: { type: "string", enum: [...WISP_BODIES], description: "The shape of the Wisp's body." },
  memory_off: {
    type: "boolean",
    description: "Set true to turn saved memory off for this Wisp, or false to turn memory on.",
  },
  model: {
    description: "Optional model override { provider, model, thinking_level? }, or null to use the app default model.",
    anyOf: [
      {
        type: "object",
        properties: {
          provider: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            description: "Provider ID, such as anthropic, openai, or claude-code.",
          },
          model: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            description: "Model ID for that provider.",
          },
          thinking_level: {
            type: "string",
            enum: [...THINKING_LEVELS],
            description: "Optional reasoning level supported by the model, such as off, low, medium, or high.",
          },
        },
        required: ["provider", "model"],
        additionalProperties: false,
      },
      { type: "null" },
    ],
  },
  fallback: {
    description:
      'Optional fallback model: "app" for the app default fallback, "none" for no fallback, or { provider, model }.',
    anyOf: [
      { type: "string", enum: ["app", "none"] },
      {
        type: "object",
        properties: {
          provider: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            description: "Fallback provider ID (must differ from the primary model's provider).",
          },
          model: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            description: "Fallback model ID.",
          },
        },
        required: ["provider", "model"],
        additionalProperties: false,
      },
    ],
  },
};

const CIRCLE_FIELDS = {
  name: { type: "string", minLength: 1, maxLength: 100, description: "The circle's name." },
  description: { type: "string", maxLength: 10_000, description: "What the circle works on, shown to its members." },
  member_ids: {
    type: "array",
    items: { type: "string", minLength: 1 },
    minItems: 1,
    maxItems: 100,
    description: "IDs of existing Wisps in the circle.",
  },
  responder: {
    type: "string",
    enum: ["lead", "auto"],
    description: 'Who answers a message with no @mention: "lead" (default) or "auto" (decision model).',
  },
};

const SCHEDULE = {
  type: "object",
  description:
    "When the job runs. once: at one time. daily: every day at a local time. weekly: on some weekdays at a local time. monthly: on a day of the month at a local time. Local times are in the user's time zone.",
  properties: {
    kind: { type: "string", enum: ["once", "daily", "weekly", "monthly"] },
    at: {
      type: "string",
      description: "For once: an ISO 8601 date and time with its offset, such as 2026-10-17T10:00:00-03:00.",
    },
    time: {
      type: "string",
      pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
      description: "For daily, weekly and monthly: HH:MM.",
    },
    weekdays: {
      type: "array",
      items: { type: "integer", minimum: 0, maximum: 6 },
      minItems: 1,
      description: "For weekly: 0 is Sunday, 6 is Saturday.",
    },
    day: {
      type: "integer",
      minimum: 1,
      maximum: 31,
      description: "For monthly: the day of the month; months without it use their last day.",
    },
    end: {
      type: "object",
      description:
        'Optional, for recurring jobs: {"kind":"until","date":"YYYY-MM-DD"} runs through that local date; {"kind":"count","count":N} stops after N runs.',
      properties: {
        kind: { type: "string", enum: ["until", "count"] },
        date: { type: "string" },
        count: { type: "integer", minimum: 1 },
      },
      required: ["kind"],
    },
  },
  required: ["kind"],
  additionalProperties: false,
};

const names = (description: string, maxItems: number, maxLength: number) => ({
  type: "array",
  items: { type: "string", minLength: 1, maxLength },
  maxItems,
  description,
});

const JOB_FIELDS = {
  title: { type: "string", minLength: 1, maxLength: MAX_JOB_TITLE_LENGTH, description: "A short title." },
  instructions: {
    type: "string",
    minLength: 1,
    maxLength: MAX_JOB_INSTRUCTIONS_LENGTH,
    description: "Self-contained instructions for every run; see Jobs in your instructions.",
  },
  schedule: SCHEDULE,
  skills: names("Names of your skills every run loads.", MAX_JOB_SKILLS, MAX_SKILL_NAME_LENGTH),
  tools: names("Names of your tools the runs need, exactly as you see them.", MAX_JOB_TOOLS, 128),
};

const object = (properties: object, required?: string[]) => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

const CASES: Array<[string, z.ZodType, object]> = [
  ["list_wisps", LIST_WISPS_PARAMETERS, object({ wisp_id: { type: "string", minLength: 1 } })],
  ["list_circles", LIST_CIRCLES_PARAMETERS, object({})],
  ["create_wisp", CREATE_WISP_PARAMETERS, object(WISP_FIELDS, ["name", "soul"])],
  [
    "update_wisp",
    UPDATE_WISP_PARAMETERS,
    object({ wisp_id: { type: "string", minLength: 1 }, ...WISP_FIELDS }, ["wisp_id"]),
  ],
  ["delete_wisp", DELETE_WISP_PARAMETERS, object({ wisp_id: { type: "string", minLength: 1 } }, ["wisp_id"])],
  [
    "create_circle",
    CREATE_CIRCLE_PARAMETERS,
    object(
      {
        ...CIRCLE_FIELDS,
        lead_id: {
          type: "string",
          minLength: 1,
          description: "Optional Wisp ID of the circle's lead; must be in member_ids. Defaults to the first member.",
        },
      },
      ["name", "member_ids"],
    ),
  ],
  [
    "update_circle",
    UPDATE_CIRCLE_PARAMETERS,
    object(
      {
        circle_id: { type: "string", minLength: 1 },
        ...CIRCLE_FIELDS,
        lead_id: {
          type: "string",
          minLength: 1,
          description: "Optional Wisp ID of the circle's lead; must be in the circle's members.",
        },
      },
      ["circle_id"],
    ),
  ],
  [
    "ask_wisp",
    ASK_WISP_PARAMETERS,
    object(
      {
        wisp_id: { type: "string", minLength: 1, description: "The ID of the Wisp to consult (from list_wisps)." },
        message: {
          type: "string",
          minLength: 1,
          maxLength: 10_000,
          description: "A clear, self-contained question or request for the target Wisp. Never include secrets.",
        },
      },
      ["wisp_id", "message"],
    ),
  ],
  ["schedule_job", SCHEDULE_JOB_PARAMETERS, object(JOB_FIELDS, ["title", "instructions", "schedule"])],
  ["list_jobs", LIST_JOBS_PARAMETERS, object({})],
  [
    "update_job",
    UPDATE_JOB_PARAMETERS,
    object({ job_id: { type: "string", minLength: 1 }, ...JOB_FIELDS }, ["job_id"]),
  ],
  ["cancel_job", CANCEL_JOB_PARAMETERS, object({ job_id: { type: "string", minLength: 1 } }, ["job_id"])],
  [
    "skip_delivery",
    SKIP_DELIVERY_PARAMETERS,
    object({ reason: { type: "string", minLength: 1, maxLength: 500 } }, ["reason"]),
  ],
  ["save_job_state", SAVE_JOB_STATE_PARAMETERS, object({ state: { type: "string" } }, ["state"])],
  [
    "search_history",
    SEARCH_HISTORY_PARAMETERS,
    object({ query: { type: "string", minLength: 1, maxLength: 200 } }, ["query"]),
  ],
  [
    "use_skill",
    USE_SKILL_PARAMETERS,
    object({ name: { type: "string", minLength: 1, maxLength: MAX_SKILL_NAME_LENGTH } }, ["name"]),
  ],
  [
    "save_skill",
    SAVE_SKILL_PARAMETERS,
    object({
      path: {
        type: "string",
        minLength: 1,
        description: "Workspace path of a complete SKILL.md file, with name and description frontmatter.",
      },
      name: {
        type: "string",
        pattern: SKILL_NAME_PATTERN.source,
        maxLength: MAX_SKILL_NAME_LENGTH,
        description: "Lowercase letters, numbers, and hyphens, for example weekly-report.",
      },
      description: {
        type: "string",
        minLength: 1,
        maxLength: MAX_SKILL_DESCRIPTION_LENGTH,
        description: "What the skill does and when to use it.",
      },
      instructions: {
        type: "string",
        minLength: 1,
        maxLength: MAX_SKILL_INSTRUCTIONS_LENGTH,
        description: "Markdown step-by-step instructions to follow when the skill applies.",
      },
    }),
  ],
  [
    "background_process",
    PROCESS_PARAMETERS,
    object(
      {
        action: { type: "string", enum: ["start", "list", "log", "wait", "kill"] },
        command: { type: "string", minLength: 1, maxLength: 10_000 },
        id: { type: "string", pattern: "^[a-f0-9]{8}$" },
        lines: { type: "integer", minimum: 1, maximum: 500 },
        timeout: { type: "integer", minimum: 1, maximum: 300 },
      },
      ["action"],
    ),
  ],
];

describe("tool schemas", () => {
  it.each(CASES)("gives %s the JSON Schema it had before zod", (_name, schema, expected) => {
    expect(toolParameters(schema)).toEqual(expected);
  });

  it("parses the arguments with the schema before the tool runs", async () => {
    const execute = vi.fn(async (_id: string, params: { name: string; count: number }) => ({
      content: [{ type: "text" as const, text: `${params.name} ${params.count}` }],
      details: {},
    }));
    const tool = defineWispTool({
      name: "example",
      label: "Example",
      description: "An example.",
      parameters: z.strictObject({ name: z.string().trim().min(1), count: z.int().min(1) }),
      execute,
    });

    await expect(
      tool.execute("call-1", { name: "  Atlas ", count: 2 }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ text: "Atlas 2" }] });
    await expect(
      tool.execute("call-2", { name: " ", count: 0, extra: true }, undefined, undefined, {} as never),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/^Invalid name: .+\. Invalid count: .+\. Unrecognized key: "extra"\.$/),
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
