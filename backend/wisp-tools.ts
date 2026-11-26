import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };
import { z } from "zod";

import { THINKING_LEVELS, type ModelSelection, type ThinkingLevel, type WispFallback } from "../shared/contracts.js";
import {
  WISP_NAME_MAX_LENGTH,
  WISP_ROLE_MAX_LENGTH,
  WISP_SOUL_MAX_LENGTH,
  withCircleLead,
  type CircleResponder,
  type NewWisp,
  type Wisp,
  type WispChanges,
} from "../shared/conversations.js";
import type { WispApprovalDetails } from "../shared/tool-policy.js";
import { DEFAULT_WISP_APPEARANCE, WISP_BODIES, WISP_COLORS } from "../shared/wisp-appearance.js";
import { formatBytes } from "../shared/workspace.js";
import { WispBackendError } from "./backend-error.js";
import type { ConversationAgentContext } from "./conversation-agent.js";
import type { ToolAuthorizationBroker } from "./tool-authorization-broker.js";
import { defineWispTool } from "./tool-schema.js";
import type { ConsultationRequest } from "./wisp-consultation.js";

/** The tools a Wisp manages the person's Wisps and circles or consults other Wisps with (ADR 024, ADR 049); never offered to job runs or consultations. */
export const WISP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_wisps",
  "list_circles",
  "list_models",
  "create_wisp",
  "update_wisp",
  "delete_wisp",
  "create_circle",
  "update_circle",
  "ask_wisp",
]);

export interface WispCreateOptions {
  model?: ModelSelection | null;
  fallback?: WispFallback;
}

export interface WispUpdateOptions {
  model?: ModelSelection | null;
  fallback?: WispFallback;
}

export interface WispCircleSummary {
  id: string;
  name: string;
  description: string;
  /** Member Wisp IDs in order; the first is the lead. */
  memberIds: ReadonlyArray<string>;
  responder: CircleResponder;
  commandsEnabled: boolean;
}

export interface NewWispCircle {
  name: string;
  description: string;
  memberIds: ReadonlyArray<string>;
  responder: CircleResponder;
}

export interface WispCircleChanges {
  name?: string;
  description?: string;
  memberIds?: ReadonlyArray<string>;
  responder?: CircleResponder;
}

/** What the Wisp tools act through; see `ConversationService` and `runtime.ts`. */
export interface WispToolHost {
  list(): ReadonlyArray<Wisp>;
  /** Creates a Wisp with its own conversation and optional model/fallback configuration. */
  create(wisp: NewWisp, options?: WispCreateOptions): Promise<Wisp>;
  update(wispId: string, changes: WispChanges, options?: WispUpdateOptions): Promise<Wisp>;
  /** Deletes a Wisp with its conversation, files, skills and jobs. */
  delete(wispId: string): Promise<void>;
  settings(wispId: string, options?: { detail?: boolean }): Promise<WispSettings>;
  /** The providers a Wisp's model can come from now, with their models. */
  listModels(): Promise<ReadonlyArray<WispModelProvider>>;
  /** Validates a model override selection and returns its display names. */
  validateModel?(selection: ModelSelection): Promise<WispModel>;
  /** Validates a fallback selection against the Wisp's primary model override and returns its display names. */
  validateFallback?(selection: ModelSelection, modelOverride: ModelSelection | null): Promise<WispModel>;
  /** Lists all circles in this environment. */
  listCircles?(): Promise<ReadonlyArray<WispCircleSummary>>;
  /** Creates a circle and notifies connected clients. */
  createCircle?(circle: NewWispCircle): Promise<WispCircleSummary>;
  /** Updates a circle and notifies connected clients. */
  updateCircle?(circleId: string, changes: WispCircleChanges): Promise<WispCircleSummary>;
  /** Consults another Wisp in an isolated turn and returns its reply. */
  ask?(request: ConsultationRequest, signal?: AbortSignal): Promise<string>;
}

/** A model by the names settings show for it, with the IDs the Wisp tools take. */
export interface WispModel {
  provider: string;
  model: string;
  providerId: string;
  modelId: string;
  /** Absent means "off". */
  thinkingLevel?: ThinkingLevel;
}

/** A provider whose models a Wisp can be set to, by name and ID. */
export interface WispModelProvider {
  id: string;
  name: string;
  /** False for Claude Code, whose models cannot stand in as a fallback. */
  fallback: boolean;
  models: ReadonlyArray<{ id: string; name: string; thinkingLevels: ReadonlyArray<ThinkingLevel> }>;
}

export interface WispCircleMembership {
  id: string;
  name: string;
  isLead: boolean;
}

export interface WispSkillInfo {
  name: string;
  description: string;
}

export interface WispJobInfo {
  title: string;
  schedule: string;
  paused: boolean;
}

export interface WispCapabilitiesInfo {
  commands: boolean;
  localNetwork: boolean;
  browser: boolean;
  workspaceUsedBytes?: number;
  workspaceQuotaBytes?: number | null;
  workspaceUnlimited?: boolean;
}

export interface WispIntegrationsInfo {
  plugins: ReadonlyArray<{ name: string; access: string }>;
  mcpServers: ReadonlyArray<{ name: string; access: string }>;
}

/**
 * Non-secret metadata about a Wisp, as another Wisp may read it: names,
 * capabilities, and access levels only — never credentials, tokens, headers,
 * secret endpoints, or raw auth configuration.
 */
export interface WispSettings {
  /** The model the Wisp answers with; null when none is chosen or the app's cannot be used. */
  model: WispModel | null;
  /** Whether that model is the Wisp's own or the app's. */
  modelSource: "wisp" | "app";
  /** The Wisp's saved model override selection, used when validating fallback updates. */
  modelOverride?: ModelSelection | null;
  /** The model that answers when the Wisp's fails; null when it has none. */
  fallback: WispModel | null;
  /** Circles the Wisp belongs to. */
  circles?: ReadonlyArray<WispCircleMembership>;
  /** Installed skills (names and descriptions only). */
  skills?: ReadonlyArray<WispSkillInfo>;
  /** Active or paused scheduled jobs for this Wisp. */
  jobs?: ReadonlyArray<WispJobInfo>;
  /** Container commands, local network, browser, and workspace usage/quota. */
  capabilities?: WispCapabilitiesInfo;
  /** Non-secret plugin and MCP server access levels. */
  integrations?: WispIntegrationsInfo;
}

export interface WispToolOptions {
  host: WispToolHost;
  context: ConversationAgentContext;
  authorizationBroker: Pick<ToolAuthorizationBroker, "authorize">;
}

/** What the Wisp is told about managing Wisps, circles, and consulting colleagues, when it has the Wisp tools. */
export const WISP_INSTRUCTIONS = [
  "## Wisps and circles",
  "The user talks with Wisps: assistants like you, each with a name, a short role, a soul (Markdown defining who it is and how it works), and settings. Multiple Wisps can also collaborate with the user in circles with a shared workspace.",
  "Use list_wisps to see every Wisp with its ID, name, role, model, and compact status hints; pass wisp_id to read one Wisp's full non-secret settings (appearance, model, reasoning level, fallback, memory, circles, skills, scheduled jobs, capabilities, workspace usage, and plugin/MCP access levels) and its soul in full. Use list_circles to see circles, their members, leads, responder modes, and whether commands are enabled. Credentials, tokens, headers, and secret endpoints are never shown.",
  "You can create, update, and delete the user's other Wisps with create_wisp, update_wisp (including memory_off, model override, and fallback model), and delete_wisp, and create or update circles with create_circle and update_circle.",
  "To set a model or fallback, pass provider and model IDs, never their display names. list_wisps shows the IDs of the models Wisps use, and list_models every model a Wisp can use with its reasoning levels.",
  "When the user wants a new Wisp, or a team of them, ask briefly what each should help with if it is not clear, then create them. Write each soul in the user's language, with sections for its identity and expertise, personality, how it works, and boundaries, so it stands alone: the new Wisp does not see this conversation.",
  "The user approves every Wisp or circle creation, change, and deletion in a card that shows all fields being set or changed, so do not repeat a soul in the chat or ask for confirmation; call the tool directly and confirm in one short sentence. Only delete a Wisp when the user asked for it. You cannot change or delete yourself; the user does that in your settings.",
  "Use ask_wisp to consult another existing Wisp directly with a self-contained question or request and receive its reply within this turn. The consulted Wisp runs with its own identity, memory, skills, workspace, and permissions; if it needs user approval for an action, the approval card appears here attributed to that Wisp. Never pass secrets in ask_wisp, and you cannot consult yourself.",
].join("\n");

const COLOR_IDS = WISP_COLORS.map(({ id }) => id) as [string, ...string[]];
const MAX_CIRCLE_NAME_LENGTH = 100;
const MAX_CIRCLE_DESCRIPTION_LENGTH = 10_000;
const MAX_ASK_MESSAGE_LENGTH = 10_000;

const MODEL_OVERRIDE_SCHEMA = z.strictObject({
  provider: z.string().trim().min(1).max(128).describe("Provider ID, such as anthropic, openai, or claude-code."),
  model: z.string().trim().min(1).max(256).describe("Model ID for that provider."),
  thinking_level: z
    .enum(THINKING_LEVELS)
    .describe("Optional reasoning level supported by the model, such as off, low, medium, or high.")
    .optional(),
});

const FALLBACK_MODEL_SCHEMA = z.union([
  z.enum(["app", "none"]),
  z.strictObject({
    provider: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe("Fallback provider ID (must differ from the primary model's provider)."),
    model: z.string().trim().min(1).max(256).describe("Fallback model ID."),
  }),
]);

const WISP_FIELDS = {
  name: z
    .string()
    .trim()
    .min(1, `A Wisp's name needs 1 to ${WISP_NAME_MAX_LENGTH} characters.`)
    .max(WISP_NAME_MAX_LENGTH, `A Wisp's name needs 1 to ${WISP_NAME_MAX_LENGTH} characters.`)
    .describe("The Wisp's name."),
  role: z
    .string()
    .trim()
    .max(WISP_ROLE_MAX_LENGTH, `A Wisp's role has at most ${WISP_ROLE_MAX_LENGTH} characters.`)
    .describe("A short role or profession shown under the name, such as Research."),
  soul: z
    .string()
    .trim()
    .max(WISP_SOUL_MAX_LENGTH, `A Wisp's soul has at most ${WISP_SOUL_MAX_LENGTH} characters.`)
    .describe("Markdown that defines the Wisp's identity, personality, how it works, and its boundaries."),
  color: z.enum(COLOR_IDS, { error: `Choose a color from: ${COLOR_IDS.join(", ")}.` }).describe("The Wisp's color."),
  body: z
    .enum(WISP_BODIES, { error: `Choose a body from: ${WISP_BODIES.join(", ")}.` })
    .describe("The shape of the Wisp's body."),
  memoryOff: z.boolean().describe("Set true to turn saved memory off for this Wisp, or false to turn memory on."),
  model: MODEL_OVERRIDE_SCHEMA.nullable().describe(
    "Optional model override { provider, model, thinking_level? }, or null to use the app default model.",
  ),
  fallback: FALLBACK_MODEL_SCHEMA.describe(
    'Optional fallback model: "app" for the app default fallback, "none" for no fallback, or { provider, model }.',
  ),
};

const WISP_ID = z.string().min(1);
const CIRCLE_ID = z.string().min(1);

const CIRCLE_FIELDS = {
  name: z
    .string()
    .trim()
    .min(1, `A circle's name needs 1 to ${MAX_CIRCLE_NAME_LENGTH} characters.`)
    .max(MAX_CIRCLE_NAME_LENGTH, `A circle's name needs 1 to ${MAX_CIRCLE_NAME_LENGTH} characters.`)
    .describe("The circle's name."),
  description: z
    .string()
    .trim()
    .max(
      MAX_CIRCLE_DESCRIPTION_LENGTH,
      `A circle's description has at most ${MAX_CIRCLE_DESCRIPTION_LENGTH} characters.`,
    )
    .describe("What the circle works on, shown to its members."),
  memberIds: z
    .array(WISP_ID)
    .min(1, "A circle needs at least one member Wisp.")
    .max(100, "A circle can have at most 100 members.")
    .describe("IDs of existing Wisps in the circle."),
  responder: z
    .enum(["lead", "auto"])
    .describe('Who answers a message with no @mention: "lead" (default) or "auto" (decision model).'),
};

export const LIST_WISPS_PARAMETERS = z.strictObject({ wisp_id: WISP_ID.optional() });
export const LIST_CIRCLES_PARAMETERS = z.strictObject({});
export const LIST_MODELS_PARAMETERS = z.strictObject({
  provider: z.string().trim().min(1).max(128).describe("Only list the models of this provider ID.").optional(),
});
export const CREATE_WISP_PARAMETERS = z.strictObject({
  name: WISP_FIELDS.name,
  role: WISP_FIELDS.role.optional(),
  soul: WISP_FIELDS.soul,
  color: WISP_FIELDS.color.optional(),
  body: WISP_FIELDS.body.optional(),
  memory_off: WISP_FIELDS.memoryOff.optional(),
  model: WISP_FIELDS.model.optional(),
  fallback: WISP_FIELDS.fallback.optional(),
});
export const UPDATE_WISP_PARAMETERS = z.strictObject({
  wisp_id: WISP_ID,
  name: WISP_FIELDS.name.optional(),
  role: WISP_FIELDS.role.optional(),
  soul: WISP_FIELDS.soul.optional(),
  color: WISP_FIELDS.color.optional(),
  body: WISP_FIELDS.body.optional(),
  memory_off: WISP_FIELDS.memoryOff.optional(),
  model: WISP_FIELDS.model.optional(),
  fallback: WISP_FIELDS.fallback.optional(),
});
export const DELETE_WISP_PARAMETERS = z.strictObject({ wisp_id: WISP_ID });
export const CREATE_CIRCLE_PARAMETERS = z.strictObject({
  name: CIRCLE_FIELDS.name,
  description: CIRCLE_FIELDS.description.optional(),
  member_ids: CIRCLE_FIELDS.memberIds,
  lead_id: WISP_ID.describe(
    "Optional Wisp ID of the circle's lead; must be in member_ids. Defaults to the first member.",
  ).optional(),
  responder: CIRCLE_FIELDS.responder.optional(),
});
export const UPDATE_CIRCLE_PARAMETERS = z.strictObject({
  circle_id: CIRCLE_ID,
  name: CIRCLE_FIELDS.name.optional(),
  description: CIRCLE_FIELDS.description.optional(),
  member_ids: CIRCLE_FIELDS.memberIds.optional(),
  lead_id: WISP_ID.describe("Optional Wisp ID of the circle's lead; must be in the circle's members.").optional(),
  responder: CIRCLE_FIELDS.responder.optional(),
});
export const ASK_WISP_PARAMETERS = z.strictObject({
  wisp_id: WISP_ID.describe("The ID of the Wisp to consult (from list_wisps)."),
  message: z
    .string()
    .trim()
    .min(1, "Pass a question or request for the Wisp.")
    .max(MAX_ASK_MESSAGE_LENGTH, `Keep the message to at most ${MAX_ASK_MESSAGE_LENGTH} characters.`)
    .describe("A clear, self-contained question or request for the target Wisp. Never include secrets."),
});

/**
 * `list_wisps`, `list_circles`, `create_wisp`, `update_wisp`, `delete_wisp`,
 * `create_circle`, `update_circle`, and `ask_wisp`. Every Wisp or circle
 * mutation asks the person in an approval card; a Wisp never changes, deletes,
 * or consults itself.
 */
export function createWispTools(options: WispToolOptions): ToolDefinition[] {
  const { host, context, authorizationBroker } = options;

  const otherWisp = (wispId: string): Wisp => {
    if (wispId === context.wispId) {
      throw new WispBackendError(
        "invalid_request",
        "You cannot change or delete yourself. The user can do it in your settings.",
      );
    }
    const wisp = host.list().find(({ id }) => id === wispId);
    if (!wisp)
      throw new WispBackendError("not_found", `No Wisp with ID ${JSON.stringify(wispId)} exists; call list_wisps.`);
    return wisp;
  };

  /**
   * Checks a model against what list_models shows before the backend validates
   * it, so a display name passed for an ID gets an error naming the ID.
   */
  const assertListedModel = async (selection: ModelSelection, use: "model" | "fallback"): Promise<void> => {
    const provider = listedProvider(await host.listModels(), selection.providerId);
    if (use === "fallback" && !provider.fallback) {
      throw new WispBackendError(
        "invalid_configuration",
        `${provider.name} models cannot be a fallback. Choose one from another provider in list_models.`,
      );
    }
    const model = provider.models.find(({ id }) => id === selection.modelId);
    if (!model) {
      const named = provider.models.find((candidate) => sameName(candidate, selection.modelId));
      throw new WispBackendError(
        "invalid_configuration",
        named
          ? `"${selection.modelId}" is a model name. Pass its ID, "${named.id}".`
          : `${provider.name} (provider ID ${provider.id}) has no model with ID "${selection.modelId}". Call list_models for its model IDs.`,
      );
    }
    const level = selection.thinkingLevel;
    if (level && level !== "off" && !model.thinkingLevels.includes(level)) {
      throw new WispBackendError(
        "invalid_configuration",
        `${model.name} does not support the reasoning level "${level}". It supports: ${model.thinkingLevels.join(", ")}.`,
      );
    }
  };

  const resolveModelParam = async (
    value: z.output<typeof WISP_FIELDS.model> | undefined,
  ): Promise<{ selection?: ModelSelection | null; label?: string }> => {
    if (value === undefined) return {};
    if (value === null) return { selection: null, label: "App default" };
    const selection: ModelSelection = {
      providerId: value.provider,
      modelId: value.model,
      ...(value.thinking_level ? { thinkingLevel: value.thinking_level } : {}),
    };
    await assertListedModel(selection, "model");
    const described = host.validateModel
      ? await host.validateModel(selection)
      : {
          provider: selection.providerId,
          model: selection.modelId,
          ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
        };
    const reasoning =
      described.thinkingLevel && described.thinkingLevel !== "off" ? ` (reasoning: ${described.thinkingLevel})` : "";
    return { selection, label: `${modelName(described)}${reasoning}` };
  };

  const resolveFallbackParam = async (
    value: z.output<typeof WISP_FIELDS.fallback> | undefined,
    primaryModelOverride: ModelSelection | null,
  ): Promise<{ fallback?: WispFallback; label?: string }> => {
    if (value === undefined) return {};
    if (value === "app") return { fallback: "global", label: "App default" };
    if (value === "none") return { fallback: "off", label: "None" };
    const selection: ModelSelection = { providerId: value.provider, modelId: value.model };
    await assertListedModel(selection, "fallback");
    const described = host.validateFallback
      ? await host.validateFallback(selection, primaryModelOverride)
      : { provider: selection.providerId, model: selection.modelId };
    return { fallback: selection, label: modelName(described) };
  };

  const resolveCircleMembers = (
    memberIds: ReadonlyArray<string>,
    leadId?: string,
  ): { memberIds: string[]; memberNames: string[]; leadName: string } => {
    const wispsById = new Map(host.list().map((wisp) => [wisp.id, wisp]));
    const deduped = [...new Set(memberIds)];
    for (const id of deduped) {
      if (!wispsById.has(id)) {
        throw new WispBackendError("not_found", `No Wisp with ID ${JSON.stringify(id)} exists; call list_wisps.`);
      }
    }
    if (leadId !== undefined && !deduped.includes(leadId)) {
      throw new WispBackendError(
        "invalid_request",
        `The lead ${JSON.stringify(leadId)} must be a member of the circle.`,
      );
    }
    const ordered = leadId ? withCircleLead(deduped, leadId) : deduped;
    const memberNames = ordered.map((id) => wispsById.get(id)!.name);
    return { memberIds: ordered, memberNames, leadName: memberNames[0]! };
  };

  const approve = (
    toolCallId: string,
    toolName: string,
    summary: string,
    details: WispApprovalDetails,
    signal?: AbortSignal,
  ) =>
    authorizationBroker.authorize(
      {
        conversationId: context.conversationId,
        wispId: context.wispId,
        toolCallId,
        toolName,
        category: "manage_wisp",
        scope: { kind: "wisp", value: details.name },
        summary,
        wisp: details,
      },
      signal,
    );

  return [
    defineWispTool({
      name: "list_wisps",
      label: "List Wisps",
      description:
        "List the user's Wisps with their IDs, names, roles, models, and status hints. Pass wisp_id to read one Wisp's full non-secret settings (appearance, model, reasoning, fallback, memory, circles, skills, scheduled jobs, capabilities, workspace usage, and integration/MCP access levels) and its soul in full. Credentials, tokens, headers, and secret endpoints are never shown.",
      parameters: LIST_WISPS_PARAMETERS,
      execute: async (_toolCallId, params) => {
        const wisps = host.list();
        if (params.wisp_id !== undefined) {
          const wisp = wisps.find(({ id }) => id === params.wisp_id);
          if (!wisp)
            throw new WispBackendError("not_found", `No Wisp with ID ${JSON.stringify(params.wisp_id)} exists.`);
          const settings = await host.settings(wisp.id, { detail: true });
          return text(formatWispDetail(wisp, context.wispId, settings));
        }
        const lines = await Promise.all(
          wisps.map(async (wisp) =>
            formatWispSummary(wisp, context.wispId, await host.settings(wisp.id, { detail: false })),
          ),
        );
        return text(lines.join("\n"));
      },
    }),
    defineWispTool({
      name: "list_circles",
      label: "List circles",
      description:
        "List the user's circles with their IDs, names, descriptions, member Wisps (noting the lead), responder mode, and whether commands are enabled.",
      parameters: LIST_CIRCLES_PARAMETERS,
      execute: async () => {
        if (!host.listCircles) throw new WispBackendError("unavailable", "Circles cannot be inspected right now.");
        const circles = await host.listCircles();
        if (!circles.length) return text("There are no circles yet.");
        const names = new Map(host.list().map(({ id, name }) => [id, name]));
        return text(circles.map((circle) => formatCircleSummary(circle, names)).join("\n\n"));
      },
    }),
    defineWispTool({
      name: "list_models",
      label: "List models",
      description:
        "List the models a Wisp can use, by provider, with the provider and model IDs that create_wisp and update_wisp take and each model's reasoning levels. Only providers with an API key or sign-in are listed.",
      parameters: LIST_MODELS_PARAMETERS,
      execute: async (_toolCallId, params) => {
        const providers = await host.listModels();
        if (!providers.length) {
          return text("No provider has an API key or sign-in yet. The user adds one in Settings → AI Model.");
        }
        const shown = params.provider === undefined ? providers : [listedProvider(providers, params.provider)];
        return text(
          [
            "Pass these IDs, not the names, as provider and model to create_wisp and update_wisp.",
            ...shown.flatMap(formatModelProvider),
          ].join("\n"),
        );
      },
    }),
    defineWispTool({
      name: "create_wisp",
      label: "Create Wisp",
      description:
        "Create a Wisp for the user, with its own conversation. Supports optional appearance, memory_off, model override, and fallback model. The user approves it in a card.",
      parameters: CREATE_WISP_PARAMETERS,
      execute: async (toolCallId, params, signal) => {
        const { selection: modelOverride, label: modelLabel } = await resolveModelParam(params.model);
        const { fallback, label: fallbackLabel } = await resolveFallbackParam(params.fallback, modelOverride ?? null);
        const wisp: NewWisp = {
          name: params.name,
          role: params.role ?? "",
          soul: params.soul,
          appearance: { ...DEFAULT_WISP_APPEARANCE, ...(params.body ? { body: params.body } : {}) },
          ...(params.color ? { color: colorValue(params.color) } : {}),
          ...(params.memory_off ? { memoryOff: true } : {}),
        };
        await approve(
          toolCallId,
          "create_wisp",
          `Create the Wisp "${wisp.name}"`,
          {
            action: "create",
            name: wisp.name,
            changes: {
              name: wisp.name,
              role: wisp.role,
              soul: wisp.soul,
              ...(params.color ? { color: params.color } : {}),
              ...(params.body ? { body: params.body } : {}),
              ...(params.memory_off !== undefined ? { memory: params.memory_off ? "off" : "on" } : {}),
              ...(modelLabel !== undefined ? { model: modelLabel } : {}),
              ...(fallbackLabel !== undefined ? { fallback: fallbackLabel } : {}),
            },
          },
          signal,
        );
        const createOptions: WispCreateOptions = {
          ...(modelOverride !== undefined ? { model: modelOverride } : {}),
          ...(fallback !== undefined ? { fallback } : {}),
        };
        const created = await host.create(wisp, Object.keys(createOptions).length ? createOptions : undefined);
        return text(`Created the Wisp "${created.name}" (ID ${created.id}). It is in the user's list of Wisps.`);
      },
    }),
    defineWispTool({
      name: "update_wisp",
      label: "Update Wisp",
      description:
        "Change another of the user's Wisps. Pass only what changes; a new soul replaces the whole soul. Supports name, role, soul, color, body, memory_off, model override (or null for app default), and fallback model. The user approves it in a card.",
      parameters: UPDATE_WISP_PARAMETERS,
      execute: async (toolCallId, params, signal) => {
        const current = otherWisp(params.wisp_id);
        const { selection: modelOverride, label: modelLabel } = await resolveModelParam(params.model);
        const primaryForFallback =
          params.fallback !== undefined
            ? params.model !== undefined
              ? (modelOverride ?? null)
              : ((await host.settings(current.id, { detail: false })).modelOverride ?? null)
            : null;
        const { fallback, label: fallbackLabel } = await resolveFallbackParam(params.fallback, primaryForFallback);
        const changes: WispChanges = {
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.role !== undefined ? { role: params.role } : {}),
          ...(params.soul !== undefined ? { soul: params.soul } : {}),
          ...(params.body ? { appearance: { ...current.appearance, body: params.body } } : {}),
          ...(params.color ? { color: colorValue(params.color) } : {}),
          ...(params.memory_off !== undefined ? { memoryOff: params.memory_off } : {}),
        };
        const updateOptions: WispUpdateOptions = {
          ...(modelOverride !== undefined ? { model: modelOverride } : {}),
          ...(fallback !== undefined ? { fallback } : {}),
        };
        if (!Object.keys(changes).length && !Object.keys(updateOptions).length) {
          throw new WispBackendError("invalid_request", "Pass at least one change.");
        }
        await approve(
          toolCallId,
          "update_wisp",
          `Change the Wisp "${current.name}"`,
          {
            action: "update",
            name: current.name,
            changes: {
              ...(changes.name !== undefined ? { name: changes.name } : {}),
              ...(changes.role !== undefined ? { role: changes.role } : {}),
              ...(changes.soul !== undefined ? { soul: changes.soul } : {}),
              ...(params.color ? { color: params.color } : {}),
              ...(params.body ? { body: params.body } : {}),
              ...(params.memory_off !== undefined ? { memory: params.memory_off ? "off" : "on" } : {}),
              ...(modelLabel !== undefined ? { model: modelLabel } : {}),
              ...(fallbackLabel !== undefined ? { fallback: fallbackLabel } : {}),
            },
          },
          signal,
        );
        const updated = await host.update(
          current.id,
          changes,
          Object.keys(updateOptions).length ? updateOptions : undefined,
        );
        return text(`Updated the Wisp "${updated.name}".`);
      },
    }),
    defineWispTool({
      name: "delete_wisp",
      label: "Delete Wisp",
      description:
        "Delete another of the user's Wisps with its conversation, files, skills and jobs. Only when the user asked for it; they approve it in a card.",
      parameters: DELETE_WISP_PARAMETERS,
      execute: async (toolCallId, params, signal) => {
        const wisp = otherWisp(params.wisp_id);
        await approve(
          toolCallId,
          "delete_wisp",
          `Delete the Wisp "${wisp.name}"`,
          { action: "delete", name: wisp.name },
          signal,
        );
        await host.delete(wisp.id);
        return text(`Deleted the Wisp "${wisp.name}".`);
      },
    }),
    defineWispTool({
      name: "create_circle",
      label: "Create circle",
      description:
        "Create a circle grouping existing Wisps into a shared conversation and workspace. The user approves it in a card.",
      parameters: CREATE_CIRCLE_PARAMETERS,
      execute: async (toolCallId, params, signal) => {
        if (!host.createCircle) throw new WispBackendError("unavailable", "Circles cannot be created right now.");
        const { memberIds, memberNames, leadName } = resolveCircleMembers(params.member_ids, params.lead_id);
        const description = params.description ?? "";
        const responder: CircleResponder = params.responder ?? "lead";
        await approve(
          toolCallId,
          "create_circle",
          `Create the circle "${params.name}"`,
          {
            target: "circle",
            action: "create",
            name: params.name,
            changes: {
              name: params.name,
              ...(description ? { description } : {}),
              members: memberNames,
              lead: leadName,
              responder,
            },
          },
          signal,
        );
        const created = await host.createCircle({ name: params.name, description, memberIds, responder });
        return text(`Created the circle "${created.name}" (ID ${created.id}). It is in the user's conversation list.`);
      },
    }),
    defineWispTool({
      name: "update_circle",
      label: "Update circle",
      description:
        "Change an existing circle's name, description, members, lead, or responder mode. Pass only what changes. The user approves it in a card.",
      parameters: UPDATE_CIRCLE_PARAMETERS,
      execute: async (toolCallId, params, signal) => {
        if (!host.listCircles || !host.updateCircle) {
          throw new WispBackendError("unavailable", "Circles cannot be updated right now.");
        }
        const current = (await host.listCircles()).find(({ id }) => id === params.circle_id);
        if (!current) {
          throw new WispBackendError(
            "not_found",
            `No circle with ID ${JSON.stringify(params.circle_id)} exists; call list_circles.`,
          );
        }
        if (
          params.name === undefined &&
          params.description === undefined &&
          params.member_ids === undefined &&
          params.lead_id === undefined &&
          params.responder === undefined
        ) {
          throw new WispBackendError("invalid_request", "Pass at least one change.");
        }
        const memberUpdate =
          params.member_ids !== undefined || params.lead_id !== undefined
            ? resolveCircleMembers(params.member_ids ?? current.memberIds, params.lead_id)
            : undefined;
        const changes: WispCircleChanges = {
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(memberUpdate ? { memberIds: memberUpdate.memberIds } : {}),
          ...(params.responder !== undefined ? { responder: params.responder } : {}),
        };
        await approve(
          toolCallId,
          "update_circle",
          `Change the circle "${current.name}"`,
          {
            target: "circle",
            action: "update",
            name: current.name,
            changes: {
              ...(params.name !== undefined ? { name: params.name } : {}),
              ...(params.description !== undefined ? { description: params.description } : {}),
              ...(params.member_ids !== undefined && memberUpdate ? { members: memberUpdate.memberNames } : {}),
              ...(memberUpdate && (params.lead_id !== undefined || params.member_ids !== undefined)
                ? { lead: memberUpdate.leadName }
                : {}),
              ...(params.responder !== undefined ? { responder: params.responder } : {}),
            },
          },
          signal,
        );
        const updated = await host.updateCircle(current.id, changes);
        return text(`Updated the circle "${updated.name}".`);
      },
    }),
    defineWispTool({
      name: "ask_wisp",
      label: "Ask Wisp",
      description:
        "Consult another existing Wisp in this environment with a self-contained question or request and receive its reply within this turn. The consulted Wisp runs with its own identity, memory, skills, workspace, and permissions. Never include secrets, and you cannot consult yourself.",
      parameters: ASK_WISP_PARAMETERS,
      execute: async (_toolCallId, params, signal) => {
        if (params.wisp_id === context.wispId) {
          throw new WispBackendError("invalid_request", "You cannot consult yourself with ask_wisp.");
        }
        const target = host.list().find(({ id }) => id === params.wisp_id);
        if (!target) {
          throw new WispBackendError(
            "not_found",
            `No Wisp with ID ${JSON.stringify(params.wisp_id)} exists; call list_wisps.`,
          );
        }
        if (!host.ask) throw new WispBackendError("unavailable", "Consulting another Wisp is not available right now.");
        const reply = await host.ask(
          {
            callerConversationId: context.conversationId,
            callerWispId: context.wispId,
            callerName: context.name,
            ...(context.role ? { callerRole: context.role } : {}),
            targetWispId: target.id,
            message: params.message,
          },
          signal,
        );
        return text(`Reply from ${target.name} (ID ${target.id}):\n\n${reply}`);
      },
    }),
  ];
}

function colorValue(id: string): string {
  return WISP_COLORS.find((color) => color.id === id)!.value;
}

function describeColor(value: string | undefined): string {
  if (!value) return "default (from name)";
  const match = WISP_COLORS.find((color) => color.value === value.toLowerCase());
  return match ? `${match.id} (${match.value})` : value;
}

function describeWisp(wisp: Wisp, selfId: string): string {
  return `${wisp.name}${wisp.id === selfId ? " (you)" : ""} (ID ${wisp.id})${wisp.role ? `: ${wisp.role}` : ""}`;
}

function modelName({ model, provider }: Pick<WispModel, "provider" | "model">): string {
  return `${model} from ${provider}`;
}

function modelIds({ providerId, modelId }: WispModel): string {
  return `provider ID ${providerId}, model ID ${modelId}`;
}

function describeModel({ model, modelSource }: WispSettings): string {
  if (!model) return "none configured";
  return `${modelName(model)} (${modelIds(model)}; ${modelSource === "wisp" ? "its own" : "the app's default"})`;
}

function sameName(candidate: { id: string; name: string }, value: string): boolean {
  const wanted = value.trim().toLowerCase();
  return candidate.name.toLowerCase() === wanted || candidate.id.toLowerCase() === wanted;
}

/** The listed provider with this ID, or an error naming its ID when a name was passed. */
function listedProvider(providers: ReadonlyArray<WispModelProvider>, providerId: string): WispModelProvider {
  const provider = providers.find(({ id }) => id === providerId);
  if (provider) return provider;
  const named = providers.find((candidate) => sameName(candidate, providerId));
  throw new WispBackendError(
    "invalid_configuration",
    named
      ? `"${providerId}" is a provider name. Pass its ID, "${named.id}".`
      : `No provider with ID "${providerId}" is available to Wisps: it is unknown or has no API key or sign-in. Call list_models for the provider IDs to use.`,
  );
}

function formatModelProvider(provider: WispModelProvider): string[] {
  return [
    `${provider.name} (provider ID ${provider.id})${provider.fallback ? "" : ". Not as a fallback."}`,
    ...provider.models.map(
      (model) => `- ${model.name} (model ID ${model.id}). Reasoning: ${model.thinkingLevels.join(", ")}`,
    ),
  ];
}

function formatWispSummary(wisp: Wisp, selfId: string, settings: WispSettings): string {
  const parts = [`${describeWisp(wisp, selfId)}. Model: ${describeModel(settings)}`];
  if (settings.circles && settings.circles.length > 0) {
    parts.push(`Circles: ${settings.circles.length}`);
  }
  const caps: string[] = [];
  if (settings.capabilities?.commands) caps.push("commands");
  if (settings.capabilities?.browser) caps.push("browser");
  if (caps.length) parts.push(`Capabilities: ${caps.join(", ")}`);
  if (wisp.memoryOff) parts.push("Memory: off");
  return parts.join(". ");
}

function formatWispDetail(wisp: Wisp, selfId: string, settings: WispSettings): string {
  const lines = [
    describeWisp(wisp, selfId),
    `Appearance: color ${describeColor(wisp.color)}, body ${wisp.appearance.body}`,
    `Model: ${describeModel(settings)}`,
    ...(settings.model ? [`Reasoning: ${settings.model.thinkingLevel ?? "off"}`] : []),
    `Fallback model: ${settings.fallback ? `${modelName(settings.fallback)} (${modelIds(settings.fallback)})` : "none"}`,
    `Memory: ${wisp.memoryOff ? "off" : "on"}`,
  ];
  if (settings.circles !== undefined) {
    lines.push(
      `Circles: ${
        settings.circles.length
          ? settings.circles
              .map((circle) => `${circle.name} (ID ${circle.id}${circle.isLead ? ", lead" : ""})`)
              .join(", ")
          : "none"
      }`,
    );
  }
  if (settings.skills !== undefined) {
    if (!settings.skills.length) lines.push("Skills: none");
    else {
      lines.push("Skills:");
      for (const skill of settings.skills) lines.push(`- ${skill.name}: ${skill.description}`);
    }
  }
  if (settings.jobs !== undefined) {
    if (!settings.jobs.length) lines.push("Scheduled jobs: none");
    else {
      lines.push("Scheduled jobs:");
      for (const job of settings.jobs) {
        lines.push(`- ${job.title} — ${job.schedule} (${job.paused ? "paused" : "enabled"})`);
      }
    }
  }
  if (settings.capabilities !== undefined) {
    const cap = settings.capabilities;
    lines.push(
      `Capabilities: commands ${cap.commands ? "enabled" : "disabled"}, local network ${cap.localNetwork ? "allowed" : "blocked"}, browser ${cap.browser ? "enabled" : "disabled"}`,
    );
    if (cap.workspaceUsedBytes !== undefined) {
      const limit = cap.workspaceUnlimited
        ? "unlimited"
        : cap.workspaceQuotaBytes
          ? formatBytes(cap.workspaceQuotaBytes)
          : "unknown";
      lines.push(`Workspace: ${formatBytes(cap.workspaceUsedBytes)} used of ${limit}`);
    }
  }
  if (settings.integrations !== undefined) {
    const { plugins, mcpServers } = settings.integrations;
    lines.push(
      `Plugins: ${plugins.length ? plugins.map((plugin) => `${plugin.name} (${plugin.access})`).join(", ") : "none"}`,
    );
    lines.push(
      `MCP servers: ${mcpServers.length ? mcpServers.map((server) => `${server.name} (${server.access})`).join(", ") : "none"}`,
    );
  }
  lines.push("Soul:", wisp.soul || "(empty)");
  return lines.join("\n");
}

function formatCircleSummary(circle: WispCircleSummary, names: ReadonlyMap<string, string>): string {
  const members = circle.memberIds.map((id, index) => {
    const name = names.get(id) ?? "Unknown Wisp";
    return `${name} (ID ${id}${index === 0 ? ", lead" : ""})`;
  });
  return [
    `${circle.name} (ID ${circle.id})`,
    ...(circle.description.trim() ? [`Description: ${circle.description.trim()}`] : []),
    `Members: ${members.join(", ") || "none"}`,
    `Responder: ${circle.responder}`,
    `Commands: ${circle.commandsEnabled ? "enabled" : "disabled"}`,
  ].join("\n");
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }], details: {} };
}
