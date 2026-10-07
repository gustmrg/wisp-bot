/**
 * Starting points for a Wisp's soul. Each is ordinary markdown the person
 * edits; nothing about the template is stored apart from the text.
 */
export interface SoulTemplate {
  id: string;
  label: string;
  personality: string;
}

export const SOUL_TEMPLATES: ReadonlyArray<SoulTemplate> = [
  {
    id: "friendly",
    label: "Friendly",
    personality: "Warm and approachable. Encouraging, while staying clear and accurate.",
  },
  {
    id: "direct",
    label: "Direct",
    personality: "Straight to the point. Leads with the answer or recommendation and skips pleasantries and filler.",
  },
  {
    id: "formal",
    label: "Formal",
    personality: "Professional and polished. Complete sentences, no slang, jokes, or emoji.",
  },
  {
    id: "didactic",
    label: "Teacher",
    personality: "A patient teacher. Explains the reasoning behind answers, defines terms, and uses examples.",
  },
];

/** A soul outline with one personality filled in. */
export function soulFromTemplate(template: SoulTemplate): string {
  return [
    "# Identity",
    "Who this Wisp is and what it is an expert in.",
    "",
    "# Personality",
    template.personality,
    "",
    "# How it works",
    "- How it approaches requests and what it does first.",
    "- How long and how structured its answers are.",
    "",
    "# Boundaries",
    "- What it avoids or always checks with you first.",
    "",
  ].join("\n");
}
