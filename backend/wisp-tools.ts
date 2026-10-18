import type { ToolDefinition } from "@earendil-works/pi-coding-agent" with { "resolution-mode": "import" };

import {
  WISP_NAME_MAX_LENGTH,
  WISP_ROLE_MAX_LENGTH,
  WISP_SOUL_MAX_LENGTH,
  type NewWisp,
  type Wisp,
  type WispChanges,
} from "../shared/conversations.js";
import type { WispApprovalDetails } from "../shared/tool-policy.js";
import { DEFAULT_WISP_APPEARANCE, WISP_BODIES, WISP_COLORS, type WispBody } from "../shared/wisp-appearance.js";
import { WispBackendError } from "./backend-error.js";
import type { ConversationAgentContext } from "./conversation-agent.js";
import type { ToolAuthorizationBroker } from "./tool-authorization-broker.js";

/** The tools a Wisp manages the person's Wisps with (ADR 024); never offered to a job's runs. */
export const WISP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_wisps",
  "create_wisp",
  "update_wisp",
  "delete_wisp",
]);

/** What the Wisp tools act through; see `ConversationService`. */
export interface WispToolHost {
  list(): ReadonlyArray<Wisp>;
  /** Creates a Wisp with its own conversation. */
  create(wisp: NewWisp): Promise<Wisp>;
  update(wispId: string, changes: WispChanges): Promise<Wisp>;
  /** Deletes a Wisp with its conversation, files, skills and jobs. */
  delete(wispId: string): Promise<void>;
}

export interface WispToolOptions {
  host: WispToolHost;
  context: ConversationAgentContext;
  authorizationBroker: Pick<ToolAuthorizationBroker, "authorize">;
}

/** What the Wisp is told about managing Wisps, when it has the Wisp tools. */
export const WISP_INSTRUCTIONS = [
  "## Wisps",
  "The user talks with Wisps: assistants like you, each with a name, a short role and a soul, the Markdown that defines who it is and how it works. You can create, change and delete the user's other Wisps with create_wisp, update_wisp and delete_wisp; list_wisps shows them.",
  "When the user wants a new Wisp, or a team of them, ask briefly what each should help with if it is not clear, then create them. Write each soul in the user's language, with sections for its identity and expertise, personality, how it works, and boundaries, so it stands alone: the new Wisp does not see this conversation.",
  "The user approves every creation, change and deletion in a card that shows it, so do not repeat a soul in the chat or ask for confirmation; call the tool directly and confirm in one short sentence. Only delete a Wisp when the user asked for it. You cannot change or delete yourself; the user does that in your settings.",
].join("\n");

const COLOR_IDS = WISP_COLORS.map(({ id }) => id);

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
  color: { type: "string", enum: COLOR_IDS, description: "The Wisp's color." },
  body: { type: "string", enum: [...WISP_BODIES], description: "The shape of the Wisp's body." },
};

interface WispFields {
  name?: string;
  role?: string;
  soul?: string;
  color?: string;
  body?: string;
}

/**
 * `list_wisps`, `create_wisp`, `update_wisp` and `delete_wisp`. Every change
 * asks the person in a card; a Wisp never changes or deletes itself, since
 * that would rebuild or remove the session it is answering from.
 */
export function createWispTools(options: WispToolOptions): ToolDefinition[] {
  const { host, context, authorizationBroker } = options;

  const otherWisp = (wispId: unknown): Wisp => {
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
        toolCallId,
        toolName,
        category: "manage_wisp",
        scope: { kind: "wisp", value: details.name },
        summary,
        wisp: details,
      },
      signal,
    );

  const tools = [
    {
      name: "list_wisps",
      label: "List Wisps",
      description:
        "List the user's Wisps with their IDs, names and roles. Pass wisp_id to read one Wisp's soul in full.",
      parameters: {
        type: "object",
        properties: { wisp_id: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: { wisp_id?: string }) => {
        const wisps = host.list();
        if (params.wisp_id !== undefined) {
          const wisp = wisps.find(({ id }) => id === params.wisp_id);
          if (!wisp)
            throw new WispBackendError("not_found", `No Wisp with ID ${JSON.stringify(params.wisp_id)} exists.`);
          return text(`${describeWisp(wisp, context.wispId)}\nSoul:\n${wisp.soul || "(empty)"}`);
        }
        return text(wisps.map((wisp) => describeWisp(wisp, context.wispId)).join("\n"));
      },
    },
    {
      name: "create_wisp",
      label: "Create Wisp",
      description:
        "Create a Wisp for the user, with its own conversation. The user approves it in a card that shows its name, role and soul.",
      parameters: {
        type: "object",
        properties: WISP_FIELDS,
        required: ["name", "soul"],
        additionalProperties: false,
      },
      execute: async (toolCallId: string, params: WispFields, signal?: AbortSignal) => {
        const fields = parseFields(params);
        if (!fields.name) throw new WispBackendError("invalid_request", "A Wisp needs a name.");
        const wisp: NewWisp = {
          name: fields.name,
          role: fields.role ?? "",
          soul: fields.soul ?? "",
          appearance: { ...DEFAULT_WISP_APPEARANCE, ...(fields.body ? { body: fields.body } : {}) },
          ...(fields.color ? { color: fields.color } : {}),
        };
        await approve(
          toolCallId,
          "create_wisp",
          `Create the Wisp "${wisp.name}"`,
          { action: "create", name: wisp.name, changes: { name: wisp.name, role: wisp.role, soul: wisp.soul } },
          signal,
        );
        const created = await host.create(wisp);
        return text(`Created the Wisp "${created.name}" (ID ${created.id}). It is in the user's list of Wisps.`);
      },
    },
    {
      name: "update_wisp",
      label: "Update Wisp",
      description:
        "Change another of the user's Wisps. Pass only what changes; a new soul replaces the whole soul. The user approves it in a card.",
      parameters: {
        type: "object",
        properties: { wisp_id: { type: "string", minLength: 1 }, ...WISP_FIELDS },
        required: ["wisp_id"],
        additionalProperties: false,
      },
      execute: async (toolCallId: string, params: WispFields & { wisp_id: string }, signal?: AbortSignal) => {
        const current = otherWisp(params.wisp_id);
        const fields = parseFields(params);
        const changes: WispChanges = {
          ...(fields.name !== undefined ? { name: fields.name } : {}),
          ...(fields.role !== undefined ? { role: fields.role } : {}),
          ...(fields.soul !== undefined ? { soul: fields.soul } : {}),
          ...(fields.body ? { appearance: { ...current.appearance, body: fields.body } } : {}),
          ...(fields.color ? { color: fields.color } : {}),
        };
        if (!Object.keys(changes).length) throw new WispBackendError("invalid_request", "Pass at least one change.");
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
            },
          },
          signal,
        );
        const updated = await host.update(current.id, changes);
        return text(`Updated the Wisp "${updated.name}".`);
      },
    },
    {
      name: "delete_wisp",
      label: "Delete Wisp",
      description:
        "Delete another of the user's Wisps with its conversation, files, skills and jobs. Only when the user asked for it; they approve it in a card.",
      parameters: {
        type: "object",
        properties: { wisp_id: { type: "string", minLength: 1 } },
        required: ["wisp_id"],
        additionalProperties: false,
      },
      execute: async (toolCallId: string, params: { wisp_id: string }, signal?: AbortSignal) => {
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
    },
  ];
  return tools as unknown as ToolDefinition[];
}

function parseFields(params: WispFields): Omit<WispFields, "color" | "body"> & { color?: string; body?: WispBody } {
  const name = params.name?.trim();
  if (name !== undefined && (!name || name.length > WISP_NAME_MAX_LENGTH)) {
    throw new WispBackendError("invalid_request", `A Wisp's name needs 1 to ${WISP_NAME_MAX_LENGTH} characters.`);
  }
  const role = params.role?.trim();
  if (role !== undefined && role.length > WISP_ROLE_MAX_LENGTH) {
    throw new WispBackendError("invalid_request", `A Wisp's role has at most ${WISP_ROLE_MAX_LENGTH} characters.`);
  }
  const soul = params.soul?.trim();
  if (soul !== undefined && soul.length > WISP_SOUL_MAX_LENGTH) {
    throw new WispBackendError("invalid_request", `A Wisp's soul has at most ${WISP_SOUL_MAX_LENGTH} characters.`);
  }
  let color: string | undefined;
  if (params.color !== undefined) {
    color = WISP_COLORS.find(({ id }) => id === params.color)?.value;
    if (!color) throw new WispBackendError("invalid_request", `Choose a color from: ${COLOR_IDS.join(", ")}.`);
  }
  let body: WispBody | undefined;
  if (params.body !== undefined) {
    body = WISP_BODIES.find((value) => value === params.body);
    if (!body) throw new WispBackendError("invalid_request", `Choose a body from: ${WISP_BODIES.join(", ")}.`);
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(soul !== undefined ? { soul } : {}),
    ...(color ? { color } : {}),
    ...(body ? { body } : {}),
  };
}

function describeWisp(wisp: Wisp, selfId: string): string {
  return `${wisp.name}${wisp.id === selfId ? " (you)" : ""} (ID ${wisp.id})${wisp.role ? `: ${wisp.role}` : ""}`;
}

function text(value: string) {
  return { content: [{ type: "text", text: value }], details: {} };
}
