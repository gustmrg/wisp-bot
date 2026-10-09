import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AuxiliaryModelSettings } from "@/components/auxiliary-model-settings";
import type { AiSettingsView, AuxiliaryModelView } from "../../shared/contracts";

function model(id: string, input: ReadonlyArray<"text" | "image">) {
  return { id, name: id.toUpperCase(), reasoning: false, input, contextWindow: 10_000, maxOutputTokens: 1_000 };
}

function view(slot: AuxiliaryModelView = { selection: null, unavailable: null }): AiSettingsView {
  return {
    selection: { providerId: "zai", modelId: "text-only" },
    auxiliary: { imageUnderstanding: slot },
    secureStorageAvailable: true,
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        credentialConfigured: true,
        models: [model("vision", ["text", "image"]), model("text-only", ["text"])],
      },
      { id: "google", name: "Google", credentialConfigured: false, models: [model("gemini", ["text", "image"])] },
    ],
    catalogError: null,
  };
}

function renderSettings(initial: AiSettingsView) {
  const saved = view({ selection: { providerId: "openai", modelId: "vision" }, unavailable: null });
  const saveAuxiliaryModel = vi.fn(async () => ({ ok: true as const, value: saved }));
  Object.defineProperty(window, "wisp", { configurable: true, value: { saveAuxiliaryModel } });
  const onViewChange = vi.fn();
  render(<AuxiliaryModelSettings view={initial} onViewChange={onViewChange} />);
  return { saveAuxiliaryModel, onViewChange, saved };
}

describe("AuxiliaryModelSettings", () => {
  it("lists only image models from providers with a saved key and saves the choice", async () => {
    const user = userEvent.setup();
    const { saveAuxiliaryModel, onViewChange, saved } = renderSettings(view());

    await user.click(screen.getByRole("combobox", { name: "Image understanding" }));

    expect(await screen.findByRole("option", { name: /Off/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /TEXT-ONLY/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GEMINI/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /VISION/ }));

    expect(saveAuxiliaryModel).toHaveBeenCalledWith({
      task: "imageUnderstanding",
      selection: { providerId: "openai", modelId: "vision" },
    });
    expect(onViewChange).toHaveBeenCalledWith(saved);
  });

  it("says why a saved model is not used and keeps it selected", () => {
    renderSettings(view({ selection: { providerId: "google", modelId: "gemini" }, unavailable: "missing_key" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Add an API key for Google to use this model.");
    expect(screen.getByRole("combobox", { name: "Image understanding" })).toHaveTextContent("gemini (unavailable)");
  });
});
