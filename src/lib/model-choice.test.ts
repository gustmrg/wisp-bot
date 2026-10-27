import { describe, expect, it } from "vitest";

import type { AiSettingsView } from "../../shared/contracts";
import { modelOptions } from "@/lib/model-choice";

const model = (id: string) =>
  ({ id, name: id, input: ["text", "image"] }) as unknown as AiSettingsView["providers"][number]["models"][number];

const view = {
  providers: [
    { id: "openai", name: "OpenAI", credentialConfigured: true, models: [model("gpt-5.5")] },
    { id: "groq", name: "Groq", credentialConfigured: false, models: [model("llama")] },
    { id: "claude-code", name: "Claude Code", credentialConfigured: true, models: [model("sonnet")] },
  ],
} as unknown as AiSettingsView;

describe("modelOptions", () => {
  it("lists the models of providers that can run, Claude Code among them unless left out", () => {
    expect(modelOptions(view).map(({ label }) => label)).toEqual(["gpt-5.5", "sonnet"]);
    // Fallback and image models run on Pi.
    expect(modelOptions(view, undefined, { runtime: "pi" }).map(({ label }) => label)).toEqual(["gpt-5.5"]);
  });
});
