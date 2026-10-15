import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FallbackModelSettings } from "@/components/fallback-model-settings";
import type { AiSettingsView, FallbackModelView } from "../../shared/contracts";

function model(id: string) {
  return {
    id,
    name: id.toUpperCase(),
    reasoning: false,
    thinkingLevels: ["off" as const],
    input: ["text" as const],
    contextWindow: 10_000,
    maxOutputTokens: 1_000,
  };
}

function view(fallback: FallbackModelView = { selection: null, unavailable: null }): AiSettingsView {
  return {
    selection: { providerId: "openai", modelId: "main" },
    auxiliary: { imageUnderstanding: { selection: null, unavailable: null } },
    fallback,
    secureStorageAvailable: true,
    providers: [
      { id: "openai", name: "OpenAI", credentialConfigured: true, models: [model("main"), model("mini")] },
      { id: "google", name: "Google", credentialConfigured: false, models: [model("gemini")] },
    ],
    catalogError: null,
  };
}

function renderSettings(initial: AiSettingsView) {
  const saved = view({ selection: { providerId: "openai", modelId: "mini" }, unavailable: null });
  const saveFallbackModel = vi.fn(async () => ({ ok: true as const, value: saved }));
  Object.defineProperty(window, "wisp", { configurable: true, value: { saveFallbackModel } });
  const onViewChange = vi.fn();
  render(<FallbackModelSettings view={initial} onViewChange={onViewChange} />);
  return { saveFallbackModel, onViewChange, saved };
}

describe("FallbackModelSettings", () => {
  it("lists models from providers with a saved key, other than the global model, and saves the choice", async () => {
    const user = userEvent.setup();
    const { saveFallbackModel, onViewChange, saved } = renderSettings(view());

    await user.click(screen.getByRole("combobox", { name: "Fallback model" }));

    expect(await screen.findByRole("option", { name: /Off/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /MAIN/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GEMINI/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /MINI/ }));

    expect(saveFallbackModel).toHaveBeenCalledWith({ selection: { providerId: "openai", modelId: "mini" } });
    expect(onViewChange).toHaveBeenCalledWith(saved);
    expect(screen.getByText("Fallback model saved.")).toBeInTheDocument();
  });

  it("turns the fallback off", async () => {
    const user = userEvent.setup();
    const { saveFallbackModel } = renderSettings(
      view({ selection: { providerId: "openai", modelId: "mini" }, unavailable: null }),
    );

    await user.click(screen.getByRole("combobox", { name: "Fallback model" }));
    await user.click(await screen.findByRole("option", { name: /Off/ }));

    expect(saveFallbackModel).toHaveBeenCalledWith({ selection: null });
  });

  it("says why a saved model is not used and keeps it selected", () => {
    renderSettings(view({ selection: { providerId: "google", modelId: "gemini" }, unavailable: "missing_key" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Add an API key for Google to use this model.");
    expect(screen.getByRole("combobox", { name: "Fallback model" })).toHaveTextContent("gemini (unavailable)");
  });
});
