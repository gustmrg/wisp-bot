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
