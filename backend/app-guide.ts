import { APP_GUIDE_TOPICS } from "./app-guide-content.js";

/** One page of the app's user guide (docs/guide), served to Wisps by `wisp_help`. */
export interface AppGuideTopic {
  id: string;
  title: string;
  /** What the topic answers; Wisps choose a topic from it. */
  summary: string;
  /** Markdown, with `wisp://` links to the screens it describes. */
  body: string;
}

export const APP_GUIDE_TOOL = "wisp_help";

/** The system prompt's part: when to read the guide, and how to point at screens. */
export const APP_GUIDE_INSTRUCTIONS = [
  "## The Wisp app",
  `You run inside Wisp, the app the user is talking to you in. When the user asks about the app itself, such as what a feature does, where a setting is, or how to set something up, call ${APP_GUIDE_TOOL} with the matching topic and answer from what it returns. If the guide does not cover the question, say so instead of guessing how the app works.`,
  "To point the user to a screen, copy the guide's Markdown link for it, for example [AI Model settings](wisp://settings/model): the app shows it as a button that opens that screen. Only use wisp:// links that appear in the guide.",
].join("\n");

export function createAppGuideTool(topics: ReadonlyArray<AppGuideTopic> = APP_GUIDE_TOPICS) {
  const index = topics.map((topic) => `- ${topic.id}: ${topic.summary}`).join("\n");
  return {
    name: APP_GUIDE_TOOL,
    label: "Read the Wisp guide",
    description: `Read a topic of the Wisp app's user guide: its features, settings screens, and how to configure them, with links that open those screens. Topics:\n${index}`,
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", enum: topics.map((topic) => topic.id), description: "The topic to read." },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    execute: async (_id: string, params: { topic: string }) => {
      const topic = topics.find((candidate) => candidate.id === params.topic);
      const text = topic ? topic.body : `No guide topic named ${JSON.stringify(params.topic)}. Topics:\n${index}`;
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}
