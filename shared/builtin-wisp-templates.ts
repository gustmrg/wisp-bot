import { SOUL_TEMPLATES, type SoulTemplate } from "./soul-templates.js";
import { DEFAULT_WISP_APPEARANCE, type WispAppearance } from "./wisp-appearance.js";
import type { WispTemplate } from "./wisp-template.js";
import { COMMAND_WORKSPACE_QUOTA_BYTES } from "./workspace.js";

/** Built-in template IDs start with this, so they can never collide with the IDs of saved ones. */
export const BUILTIN_WISP_TEMPLATE_PREFIX = "builtin-";

/** How each built-in looks and what it starts with, beside its soul. */
interface BuiltInExtras {
  name: string;
  color: string;
  appearance: Partial<WispAppearance>;
  skills?: ReadonlyArray<string>;
  setup?: WispTemplate["setup"];
}

const skill = (name: string, description: string, steps: ReadonlyArray<string>) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n`;

const EXTRAS: Readonly<Record<string, BuiltInExtras>> = {
  assistant: { name: "Pip", color: "#885cf5", appearance: { body: "round", trail: "hook", eyes: "wisp" } },
  research: {
    name: "Atlas",
    color: "#54b9a6",
    appearance: { body: "drop", trail: "curl", eyes: "oval" },
    skills: [
      skill("source-brief", "Writes a short brief on a question, with a source for every claim.", [
        "Restate the question in one line and say what is out of scope.",
        "Find at least three independent sources; prefer primary ones and note each one's date.",
        "Write the answer first in two or three sentences, then the evidence, one claim per bullet with its source.",
        "End with what is still uncertain and what would settle it.",
      ]),
    ],
  },
  code: {
    name: "Forge",
    color: "#6464ef",
    appearance: { body: "block", trail: "none", eyes: "slit" },
    skills: [
      skill("fix-a-failing-test", "Finds why a test fails and makes the smallest change that fixes it.", [
        "Run the failing test alone and read the first real error, not the last line.",
        "Write down what the test expects and what the code does instead.",
        "Change the code, not the test, unless the test is wrong; say which and why.",
        "Run the test, then the whole suite, and report both results.",
      ]),
    ],
    setup: { quotaBytes: COMMAND_WORKSPACE_QUOTA_BYTES, executionMode: "container" },
  },
  writing: {
    name: "Quill",
    color: "#e5498f",
    appearance: { body: "pebble", trail: "flame", eyes: "dot" },
    skills: [
      skill("tighten-a-draft", "Cuts a draft to what matters while keeping the author's voice.", [
        "Read the whole draft before changing anything and name its one main point.",
        "Cut sentences that do not serve that point, then words that do not serve their sentence.",
        "Keep the author's words where they work; change tone only when asked.",
        "Return the edited draft, then a short list of the larger changes.",
      ]),
    ],
  },
  projects: {
    name: "Sage",
    color: "#ed712e",
    appearance: { body: "pebble", trail: "flame", eyes: "arc", mark: "spark" },
  },
  tutor: { name: "Owl", color: "#3c82f6", appearance: { body: "round", trail: "curl", eyes: "oval" } },
};

function builtIn(soul: SoulTemplate): { id: string; template: WispTemplate } {
  const extras = EXTRAS[soul.id];
  return {
    id: `${BUILTIN_WISP_TEMPLATE_PREFIX}${soul.id}`,
    template: {
      name: extras?.name ?? soul.label,
      role: soul.label,
      soul: soul.soul,
      description: soul.description,
      appearance: { ...DEFAULT_WISP_APPEARANCE, ...extras?.appearance },
      ...(extras?.color ? { color: extras.color } : {}),
      ...(extras?.skills ? { skills: extras.skills.map((contents) => ({ contents })) } : {}),
      ...(extras?.setup ? { setup: extras.setup } : {}),
    },
  };
}

/**
 * Templates that ship with the app, one per starting soul. They are read-only
 * and change with the app's version; duplicating one makes an editable copy.
 * None asks for access to plugins or MCP servers.
 */
export const BUILTIN_WISP_TEMPLATES: ReadonlyArray<{ id: string; template: WispTemplate }> =
  SOUL_TEMPLATES.map(builtIn);
