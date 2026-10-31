/** How many starters an empty conversation offers. */
const MAX_STARTERS = 4;

/** Every Wisp can create Wisps, so these fit any conversation; they lead while the person has only one. */
const TEAM_STARTERS = ["Help me build a team of Wisps", "Create an assistant Wisp for me"];

/** First messages that work without any context and show what a Wisp can do. */
const GENERAL_STARTERS = [
  "What can you help me with?",
  "Help me plan my week",
  "Every morning, send me a short summary of the news",
  "How can I connect you to my email or calendar?",
];

/**
 * The prompts an empty conversation offers to send. Right after onboarding the
 * person has a single Wisp, so building the team comes first.
 */
export function conversationStarters(options: { soleWisp: boolean }): ReadonlyArray<string> {
  return (options.soleWisp ? [...TEAM_STARTERS, ...GENERAL_STARTERS] : GENERAL_STARTERS).slice(0, MAX_STARTERS);
}

/**
 * The prompts an empty circle offers to send. They show what sets a circle
 * apart: who answers, mentions and handoffs. Jobs and commands stay out, since
 * a circle has neither (ADR 011). The mention names a member other than the
 * lead, who answers without one anyway.
 */
export function circleStarters(options: {
  memberNames: ReadonlyArray<string>;
  hasDescription: boolean;
}): ReadonlyArray<string> {
  const { memberNames, hasDescription } = options;
  if (!memberNames.length) return [];
  const start = hasDescription ? ["Where should we start?"] : [];
  const other = memberNames[1];
  if (other === undefined) return ["What can you help me with?", ...start];
  return [
    "What can this team help me with?",
    `@${other}, what can you do?`,
    ...start,
    "Help me split a task between you",
  ];
}
